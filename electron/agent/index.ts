import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { URL } from 'url'
import { v4 as uuidv4 } from 'uuid'
import { executeTool, CORE_TOOLS, getToolByName, getToolRiskLevel, isToolConcurrencySafe, searchTools } from './tools'
import { AgentMessage } from './types'
import { extractFileContent } from '../utils/file-extract'
import type { LocalModelManager } from '../local-model/index'
import { BrowserManager } from './browser'
import { HooksManager } from './hooks'

interface SkillData {
  name: string
  displayName: string
  description: string
  content: string
  memory?: string | null
}

interface SessionToolCallData {
  id?: string
  name?: string
  arguments?: string
  status?: 'pending' | 'running' | 'completed' | 'error' | string
  result?: string
  error?: string
  resultFilePath?: string
}

interface SessionContentBlockData {
  type?: 'text' | 'tool-call' | 'iteration-end' | string
  content?: string
  toolCallId?: string
  iterationIndex?: number
}

interface SessionMessageData {
  role?: 'system' | 'user' | 'assistant' | 'tool' | string
  content?: string
  toolCalls?: SessionToolCallData[]
  contentBlocks?: SessionContentBlockData[]
}

interface SessionMemoryData {
  content: string
  updatedAt: number
  version?: number
}

type RestoredToolCall = NonNullable<AgentMessage['tool_calls']>[number]

const MAX_ATTACHED_FILES = 8
const MAX_ATTACHED_FILE_CHARS = 12000
const MAX_TOTAL_ATTACHED_CHARS = 40000
const MAX_RESTORED_TOOL_CONTENT_CHARS = 3000
const MAX_SKILL_CONTENT_CHARS = 5000
const SKILL_SYSTEM_MARKER_PREFIX = '[ONIT_SKILL:'

// Context / token budgets
const DEFAULT_MAX_INPUT_TOKENS = 95000
const DEFAULT_MAX_OUTPUT_TOKENS = 65000
// Soft working-set target: we try to keep most model calls around this input
// size for latency stability, while preserving older context in Session Memory.
const SOFT_WORKING_SET_TOKENS = 64000
// Keep a safety margin because our token estimation is approximate and models
// differ in tokenization details.
const CONTEXT_TOKEN_SAFETY_MARGIN = 1500
// Approximate tokenizer: 1 token ~= 3.2 UTF-8 bytes (conservative).
const TOKEN_EST_BYTES_PER_TOKEN = 3.2
const TOKEN_EST_MESSAGE_OVERHEAD = 6

// Tool output handling
const TOOL_ARTIFACT_MAX_CHARS = 240000
const TOOL_CONTEXT_MAX_CHARS_DEFAULT = 8000
const TOOL_CONTEXT_MAX_CHARS_LARGE_TEXT = 20000
const TOOL_CONTEXT_MAX_CHARS_OLD_TOOL = 900
const TOOL_CONTEXT_RECENT_GROUPS = 10
const SESSION_MEMORY_MARKER = '[ONIT_SESSION_MEMORY]'

// Micro-compaction: zero-cost replacement of old tool results with stubs
const MICROCOMPACT_KEEP_RECENT = 8
const MICROCOMPACT_MAX_SUMMARY_CHARS = 200 // keep first N chars as summary instead of fully clearing
// Only compact tools whose old results are unlikely to be needed for decision-making.
// EXCLUDED: web_search, web_fetch, browser_extract — these are research results
// that the agent needs to remember to avoid repeating the same searches.
const MICROCOMPACT_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'execute_command',
  'list_directory', 'search_files', 'search_content',
  'browser_navigate', 'browser_action', 'browser_screenshot',
  'notebook_edit', 'worktree_create', 'worktree_remove', 'find_symbol',
])
const SESSION_MEMORY_MAX_OUTPUT_TOKENS = 4000
const SESSION_MEMORY_MERGE_SOURCE_MAX_TOKENS = 22000
const SESSION_MEMORY_MAX_PASSES = 6
// Throttle Session Memory compression in long-running loops to avoid excessive
// extra LLM calls. If the prompt grows far beyond the soft budget, compression
// may bypass these limits.
const SESSION_MEMORY_SOFT_MIN_INTERVAL_MS = 30000
const SESSION_MEMORY_SOFT_MIN_ITERATIONS = 3
const SESSION_MEMORY_SOFT_MIN_DROPPED_TOKENS = 2500
const SESSION_MEMORY_SOFT_FORCE_DROPPED_TOKENS = 12000

// Model call reconnection / retries for transient failures.
const MODEL_RECONNECT_MAX_RETRIES = 5
const MODEL_RECONNECT_BASE_DELAY_MS = 2000
const MODEL_RECONNECT_MAX_DELAY_MS = 15000
const MODEL_RECONNECT_JITTER_RATIO = 0.15

// Streaming idle watchdog
const STREAM_IDLE_TIMEOUT_MS = 90_000
const STREAM_STALL_THRESHOLD_MS = 30_000

// max_output_tokens recovery
const MAX_OUTPUT_RECOVERY_LIMIT = 3
const MAX_OUTPUT_RECOVERY_PROMPT = 'Your previous response was cut off due to output token limit. Resume directly from where you stopped — no apology, no recap, no re-stating what you already said. Pick up mid-thought or mid-code and continue.'

// Compression circuit breaker + dual trigger
const COMPRESSION_MAX_CONSECUTIVE_FAILURES = 3
const COMPRESSION_INIT_TOKEN_THRESHOLD = 10_000
const COMPRESSION_TOOL_CALL_THRESHOLD = 2

// NOTE: Bash security patterns are consolidated in tools.ts getToolRiskLevel()
// to avoid duplication. See the execute_command case there.

interface AgentSession {
  sessionId: string
  runId: string
  messages: AgentMessage[]
  abortController: AbortController | null
  isRunning: boolean
  completionStatus: 'completed' | 'stopped' | 'error'
  permissionMode: string
  /** Non-plan mode to restore after a temporary enter_plan_mode approval. */
  returnPermissionMode: string | null
  workspacePath: string | null
  model: string
  sessionMemory: SessionMemoryData | null
  effectiveMaxInputTokens?: number
  effectiveMaxOutputTokens?: number
  lastMemoryCompressionAt: number
  lastMemoryCompressionIteration: number
  isMemoryCompressionRunning: boolean
  /** Circuit breaker: consecutive compression failures. Disabled after 3. */
  compressionFailures: number
  /** Tool calls since last compression (for dual-trigger). */
  toolCallsSinceLastCompression: number
  /** Total tokens ever seen (for initialization gate). */
  totalTokensSeen: number
  apiConfig: {
    billingMode: string
    apiKey: string
    model?: string
    customBaseUrl?: string
    codingPlanProvider?: string
    localModelId?: string
    maxInputTokens?: number
    maxOutputTokens?: number
  }
  alwaysAllowedTools: Set<string>
  pendingPermissions: Map<string, { resolve: (approved: boolean) => void }>
  enabledSkills?: SkillData[]
  /** Maps skill name → how many runs ago it was last loaded/invoked (0 = this run). */
  usedSkillNames: Map<string, number>
  /** Deferred tools explicitly loaded for this session via tool_search. */
  loadedDeferredToolNames: Set<string>
  runPromise?: Promise<void>
  browserManager?: BrowserManager
  /** Tracks files read in this session for read-before-edit enforcement. */
  readFiles: Set<string>
  /** Pending answer texts for ask_user tool (keyed by requestId). */
  pendingAnswers: Map<string, string>
}

export class AgentManager {
  private sessions: Map<string, AgentSession> = new Map()
  private sendToRenderer: (channel: string, data: any) => void
  private artifactsDir: string | null
  private localModelManager: LocalModelManager | null
  /** Persisted "Always Allow" tools (shared across sessions, saved to disk). */
  private persistedAllowedTools: Set<string> = new Set()
  /** Content-level permission rules (tool + pattern → allow/deny). */
  private permissionRules: Array<{ tool: string; pattern: string; behavior: string }> = []
  /** Lifecycle hooks manager. */
  private hooksManager = new HooksManager()
  private onRunComplete: ((params: {
    sessionId: string
    runId: string
    /** Skills loaded or invoked in this run (for usage count). */
    currentRunSkillNames: string[]
    /** All skills seen within the recording window (for evolution recording). */
    sessionSkillNames: string[]
    messages: AgentMessage[]
    apiConfig: AgentSession['apiConfig']
  }) => void) | null = null

  // Optional overrides for Copilot orchestrator mode
  private toolsOverride: any[] | null
  private toolExecutorOverride: ((name: string, args: string, workspace: string | null, opts: any) => Promise<any>) | null
  private systemPromptPrepend: string | null

  constructor(
    sendToRenderer: (channel: string, data: any) => void,
    options?: {
      artifactsDir?: string
      localModelManager?: LocalModelManager
      onRunComplete?: AgentManager['onRunComplete']
      toolsOverride?: any[]
      toolExecutorOverride?: (name: string, args: string, workspace: string | null, opts: any) => Promise<any>
      systemPromptPrepend?: string
    }
  ) {
    this.sendToRenderer = sendToRenderer
    this.artifactsDir = options?.artifactsDir || null
    this.localModelManager = options?.localModelManager || null
    this.onRunComplete = options?.onRunComplete || null
    this.toolsOverride = options?.toolsOverride || null
    this.toolExecutorOverride = options?.toolExecutorOverride || null
    this.systemPromptPrepend = options?.systemPromptPrepend || null
    this.loadPersistedPermissions()
  }

  private getPermissionsFilePath(): string {
    const dataDir = this.artifactsDir
      ? path.dirname(this.artifactsDir)
      : path.join(os.homedir(), 'Library', 'Application Support', 'onit', 'onit-data')
    return path.join(dataDir, 'permissions.json')
  }

  private loadPersistedPermissions(): void {
    try {
      const filePath = this.getPermissionsFilePath()
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        if (Array.isArray(data.alwaysAllowedTools)) {
          this.persistedAllowedTools = new Set(data.alwaysAllowedTools)
        }
        // Load permission rules
        if (Array.isArray(data.rules)) {
          this.permissionRules = data.rules
        }
      }
    } catch {
      // Non-fatal: start with empty set
    }
  }

  private savePersistedPermissions(): void {
    try {
      const filePath = this.getPermissionsFilePath()
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify({
        alwaysAllowedTools: Array.from(this.persistedAllowedTools),
        rules: this.permissionRules,
        updatedAt: Date.now(),
      }, null, 2), 'utf-8')
    } catch {
      // Non-fatal
    }
  }

  /**
   * Check content-level permission rules.
   * Rules format: { tool: 'execute_command', pattern: 'git:*', behavior: 'allow' }
   * Pattern matching: exact, prefix (ends with :*), or wildcard (* anywhere).
   */
  private checkPermissionRules(toolName: string, args: any): 'allow' | 'deny' | null {
    if (!this.permissionRules || this.permissionRules.length === 0) return null

    const content = toolName === 'execute_command'
      ? (args.command || '')
      : (args.path || args.url || '')

    for (const rule of this.permissionRules) {
      if (rule.tool !== toolName) continue

      const pattern = rule.pattern || ''
      let matches = false

      if (pattern.endsWith(':*')) {
        // Prefix match: "git:*" matches "git status", "git commit", etc.
        const prefix = pattern.slice(0, -2)
        matches = content.startsWith(prefix) || content.toLowerCase().startsWith(prefix.toLowerCase())
      } else if (pattern.includes('*')) {
        // Wildcard: convert glob to regex (escape all special chars except *, then replace * with .*)
        try {
          const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
          const regex = new RegExp('^' + escaped + '$', 'i')
          matches = regex.test(content)
        } catch { matches = false }
      } else {
        // Exact match
        matches = content === pattern || content.toLowerCase() === pattern.toLowerCase()
      }

      if (matches) return rule.behavior as 'allow' | 'deny'
    }

    return null
  }

  async startAgent(sessionId: string, userMessage: string, runId: string, sessionData: any): Promise<boolean> {
    let agentSession = this.sessions.get(sessionId)

    if (agentSession?.isRunning) {
      this.stopAgent(sessionId)
      if (agentSession.runPromise) {
        await agentSession.runPromise.catch(() => {})
      }
    }

    const apiConfig = sessionData.apiConfig || {}

    // Ensure local model is loaded for local-model mode
    if (apiConfig.billingMode === 'local-model') {
      if (!this.localModelManager) {
        throw new Error('Local model support is not available')
      }
      const modelId = apiConfig.localModelId
      if (!modelId) {
        throw new Error('No local model selected')
      }
      // loadModel() is idempotent when the same model is already loaded.
      await this.localModelManager.loadModel(modelId)
    }

    const sessionMemory: SessionMemoryData | null = sessionData.sessionMemory && typeof sessionData.sessionMemory.content === 'string'
      ? {
          content: sessionData.sessionMemory.content,
          updatedAt: typeof sessionData.sessionMemory.updatedAt === 'number' ? sessionData.sessionMemory.updatedAt : Date.now(),
          version: typeof sessionData.sessionMemory.version === 'number' ? sessionData.sessionMemory.version : 1,
        }
      : null
    const enabledSkills: SkillData[] = sessionData.enabledSkills || []
    const attachedFileMessages = await this.buildAttachedFileMessages(sessionData.attachedFiles || [])

    // Parse @skill-name mentions from user message and inject skill content
    const { contents: mentionedSkillContents, names: mentionedSkillNames } = this.extractMentionedSkills(userMessage, enabledSkills)

    // Build the system prompt
    const systemPrompt = this.buildCurrentSystemPrompt({
      workspacePath: sessionData.workspacePath,
      permissionMode: sessionData.permissionMode || 'accept-edit',
      enabledSkills,
    })

    // Restore conversation history from session
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt }
    ]

    if (sessionMemory?.content) {
      messages.push({ role: 'system', content: this.buildSessionMemorySystemMessage(sessionMemory.content) })
    }

    // Inject mentioned skill contents as system messages
    for (const skillContent of mentionedSkillContents) {
      messages.push({ role: 'system', content: skillContent })
    }

    for (const attachedFileMessage of attachedFileMessages) {
      messages.push(attachedFileMessage)
    }

    // Add existing messages from session (convert from renderer format)
    if (sessionData.messages) {
      messages.push(...this.restoreConversationHistory(sessionData.messages as SessionMessageData[]))
    }

    // Add the new user message
    messages.push({ role: 'user', content: userMessage })

    agentSession = {
      sessionId,
      runId,
      messages,
      abortController: new AbortController(),
      isRunning: true,
      completionStatus: 'completed',
      permissionMode: sessionData.permissionMode || 'accept-edit',
      returnPermissionMode: agentSession?.returnPermissionMode || null,
      workspacePath: sessionData.workspacePath,
      model: sessionData.model || 'qianfan-code-latest',
      sessionMemory,
      effectiveMaxInputTokens: undefined,
      effectiveMaxOutputTokens: undefined,
      lastMemoryCompressionAt: 0,
      lastMemoryCompressionIteration: 0,
      isMemoryCompressionRunning: false,
      compressionFailures: 0,
      toolCallsSinceLastCompression: 0,
      totalTokensSeen: 0,
      apiConfig: {
        billingMode: apiConfig.billingMode || 'coding-plan',
        apiKey: apiConfig.apiKey || '',
        model: apiConfig.model || sessionData.model,
        customBaseUrl: apiConfig.customBaseUrl,
        codingPlanProvider: apiConfig.codingPlanProvider,
        localModelId: apiConfig.localModelId,
        maxInputTokens: apiConfig.maxInputTokens,
        maxOutputTokens: apiConfig.maxOutputTokens,
      },
      alwaysAllowedTools: agentSession?.alwaysAllowedTools || new Set(this.persistedAllowedTools),
      readFiles: agentSession?.readFiles || new Set(),
      pendingAnswers: new Map(),
      pendingPermissions: new Map(),
      enabledSkills,
      usedSkillNames: new Map<string, number>(),
      loadedDeferredToolNames: agentSession?.loadedDeferredToolNames || new Set<string>(),
    }

    // Current @-mentions in this message → distance 0 (this run)
    for (const name of mentionedSkillNames) {
      agentSession.usedSkillNames.set(name, 0)
    }

    // Scan conversation history for previously @-mentioned skills.
    // Older @-mentions get a higher distance (number of runs since mention).
    // We count runs backwards: each user message in history = 1 prior run.
    if (sessionData.messages) {
      const userMessages: SessionMessageData[] = (sessionData.messages as SessionMessageData[])
        .filter((m: SessionMessageData) => m.role === 'user')
      const totalPriorRuns = userMessages.length

      for (let i = 0; i < userMessages.length; i++) {
        const msg = userMessages[i]
        if (!msg.content) continue
        const runsAgo = totalPriorRuns - i // most recent prior run = 1, oldest = totalPriorRuns
        const histPattern = /@([\w-]+)/g
        let histMatch: RegExpExecArray | null
        while ((histMatch = histPattern.exec(msg.content)) !== null) {
          const skillName = histMatch[1]
          if (!enabledSkills.some(s => s.name === skillName)) continue
          // Keep the smallest distance (most recent mention)
          const existing = agentSession.usedSkillNames.get(skillName)
          if (existing === undefined || runsAgo < existing) {
            agentSession.usedSkillNames.set(skillName, runsAgo)
          }
        }
      }
    }

    // Compress older history into Session Memory (if needed) and then ensure
    // the initial prompt stays within budget.
    await this.maybeCompressSessionMemory(agentSession, {
      maxInputTokensOverride: this.getSoftWorkingSetTokens(agentSession),
      force: true,
    })
    this.pruneConversationForTokenBudget(agentSession, {
      maxInputTokensOverride: this.getEffectiveMaxInputTokens(agentSession),
    })

    this.sessions.set(sessionId, agentSession)

    // Load lifecycle hooks for this workspace
    this.hooksManager.loadHooks(agentSession.workspacePath)

    // Run the agent loop asynchronously
    agentSession.runPromise = this.runAgentLoop(agentSession).catch(error => {
      this.sendToRenderer('agent:error', {
        sessionId,
        runId,
        error: error.message || 'Unknown agent error',
      })
    })

    return true
  }

  stopAgent(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.isRunning = false
      session.completionStatus = 'stopped'
      session.abortController?.abort()
      for (const [, pending] of session.pendingPermissions) {
        pending.resolve(false)
      }
      session.pendingPermissions.clear()
      session.pendingAnswers.clear()
      // Close browser if open
      if (session.browserManager) {
        session.browserManager.close().catch(() => {})
        session.browserManager = undefined
      }
    }
    return true
  }

  getRunningSessionIds(): string[] {
    const ids: string[] = []
    for (const [id, session] of this.sessions) {
      if (session.isRunning) ids.push(id)
    }
    return ids
  }

  stopAll(): void {
    for (const [sessionId] of this.sessions) {
      this.stopAgent(sessionId)
    }
  }

  isSessionRunning(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isRunning === true
  }

  handlePermissionResponse(requestId: string, approved: boolean, alwaysAllow?: boolean): void {
    for (const [, session] of this.sessions) {
      const pending = session.pendingPermissions.get(requestId)
      if (pending) {
        if (alwaysAllow && approved) {
          const parts = requestId.split(':')
          if (parts.length > 1) {
            const toolName = parts[1]
            session.alwaysAllowedTools.add(toolName)
            // Persist to disk for future sessions
            this.persistedAllowedTools.add(toolName)
            this.savePersistedPermissions()
          }
        }
        pending.resolve(approved)
        session.pendingPermissions.delete(requestId)
        return
      }
    }
  }

  private normalizeSkillName(skillName: string): string {
    return (skillName || '').trim().replace(/^[@/]+/, '')
  }

  private findEnabledSkill(skillName: string, enabledSkills: SkillData[]): SkillData | null {
    const normalizedName = this.normalizeSkillName(skillName)
    if (!normalizedName) return null
    const normalizedLower = normalizedName.toLowerCase()
    return enabledSkills.find(skill => skill.name.toLowerCase() === normalizedLower) || null
  }

  private buildSkillSystemMarker(skillName: string): string {
    return `${SKILL_SYSTEM_MARKER_PREFIX}${skillName}]`
  }

  private isInjectedSkillSystemMessage(message: AgentMessage, skillName?: string): boolean {
    if (message.role !== 'system' || typeof message.content !== 'string') {
      return false
    }
    if (!skillName) {
      return message.content.startsWith(SKILL_SYSTEM_MARKER_PREFIX)
    }
    return message.content.startsWith(this.buildSkillSystemMarker(skillName))
  }

  private buildInjectedSkillContent(skill: SkillData): string {
    let fullContent = skill.content
    if (skill.memory) {
      fullContent += '\n\n## Skill Memory\n\n' + skill.memory
    }
    const injected = fullContent.length > MAX_SKILL_CONTENT_CHARS
      ? fullContent.substring(0, MAX_SKILL_CONTENT_CHARS) + '\n\n[Skill content truncated]'
      : fullContent
    return `${this.buildSkillSystemMarker(skill.name)} ${skill.displayName}\n\n${injected}`
  }

  private loadSkillIntoSession(agentSession: AgentSession, rawSkillName: string): {
    success: boolean
    output: string
    injectedMessage?: AgentMessage
  } {
    const enabledSkills = agentSession.enabledSkills || []
    if (enabledSkills.length === 0) {
      return { success: false, output: 'No skills are enabled in this session.' }
    }

    const skill = this.findEnabledSkill(rawSkillName, enabledSkills)
    if (!skill) {
      const available = enabledSkills.map(s => `@${s.name}`).join(', ')
      return {
        success: false,
        output: `Unknown skill "${rawSkillName}". Available skills: ${available}`,
      }
    }

    if (agentSession.messages.some(message => this.isInjectedSkillSystemMessage(message, skill.name))) {
      agentSession.usedSkillNames.set(skill.name, 0)
      return {
        success: true,
        output: `Skill "${skill.displayName}" is already loaded for this run.`,
      }
    }

    agentSession.usedSkillNames.set(skill.name, 0)

    return {
      success: true,
      output: `Skill "${skill.displayName}" loaded for this run. Follow its instructions until they no longer apply.`,
      injectedMessage: {
        role: 'system',
        content: this.buildInjectedSkillContent(skill),
      },
    }
  }

  private getToolsForSession(agentSession: AgentSession): any[] {
    if (agentSession.loadedDeferredToolNames.size === 0) {
      return CORE_TOOLS
    }

    const loadedDeferredTools = Array.from(agentSession.loadedDeferredToolNames)
      .map(toolName => getToolByName(toolName))
      .filter((tool): tool is NonNullable<ReturnType<typeof getToolByName>> => Boolean(tool))

    if (loadedDeferredTools.length === 0) {
      return CORE_TOOLS
    }

    return [...CORE_TOOLS, ...loadedDeferredTools]
  }

  private extractMentionedSkills(message: string, enabledSkills: SkillData[]): { contents: string[]; names: string[] } {
    const contents: string[] = []
    const names: string[] = []
    const seen = new Set<string>()
    const mentionPattern = /@([\w-]+)/g
    let match: RegExpExecArray | null

    while ((match = mentionPattern.exec(message)) !== null) {
      const skill = this.findEnabledSkill(match[1], enabledSkills)
      if (skill && skill.content && !seen.has(skill.name)) {
        contents.push(this.buildInjectedSkillContent(skill))
        names.push(skill.name)
        seen.add(skill.name)
      }
    }

    return { contents, names }
  }

  private async buildAttachedFileMessages(attachedFiles: string[]): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = []
    let totalChars = 0

    for (const filePath of attachedFiles.slice(0, MAX_ATTACHED_FILES)) {
      const remainingChars = MAX_TOTAL_ATTACHED_CHARS - totalChars
      if (remainingChars <= 0) break

      try {
        const result = await extractFileContent(filePath)
        const header = result.header || `[Attached File: ${filePath}]`
        const content = result.content || ''

        if (!content) {
          // File had no extractable content (image, audio, or parse failure)
          messages.push({ role: 'system', content: header })
          continue
        }

        const cap = Math.min(MAX_ATTACHED_FILE_CHARS, remainingChars)
        const truncated = content.length > cap
        const excerpt = truncated ? `${content.slice(0, cap)}\n\n[Content truncated]` : content

        totalChars += excerpt.length
        messages.push({
          role: 'system',
          content: `${header}\n\n${excerpt}`,
        })
      } catch {
        messages.push({
          role: 'system',
          content: `[Attached File Unreadable: ${filePath}]`,
        })
      }
    }

    return messages
  }

  private restoreConversationHistory(sessionMessages: SessionMessageData[]): AgentMessage[] {
    const restored: AgentMessage[] = []

    for (const message of sessionMessages) {
      if (!message) continue

      if (message.role === 'user') {
        restored.push({ role: 'user', content: typeof message.content === 'string' ? message.content : '' })
        continue
      }

      if (message.role === 'assistant') {
        restored.push(...this.restoreAssistantMessage(message))
      }
    }

    return restored
  }

  private restoreAssistantMessage(message: SessionMessageData): AgentMessage[] {
    const contentBlocks = Array.isArray(message.contentBlocks) ? message.contentBlocks : []

    if (contentBlocks.length > 0) {
      const restoredFromBlocks = this.restoreAssistantMessageFromBlocks(message)
      if (restoredFromBlocks.length > 0) {
        return restoredFromBlocks
      }
    }

    return this.restoreAssistantMessageFallback(message)
  }

  private restoreAssistantMessageFromBlocks(message: SessionMessageData): AgentMessage[] {
    const restored: AgentMessage[] = []
    const contentBlocks = Array.isArray(message.contentBlocks) ? message.contentBlocks : []
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : []
    const toolCallMap = new Map<string, SessionToolCallData>()
    const consumedToolCallIds = new Set<string>()

    for (const toolCall of toolCalls) {
      if (toolCall.id) {
        toolCallMap.set(toolCall.id, toolCall)
      }
    }

    let currentText = ''
    let currentToolCallIds: string[] = []

    const flushCurrentTurn = () => {
      const assistantContent = this.normalizeRestoredAssistantContent(currentText)
      const restoredToolCalls = currentToolCallIds
        .map(toolCallId => {
          const toolCall = toolCallMap.get(toolCallId)
          if (!toolCall) return null
          consumedToolCallIds.add(toolCallId)
          return this.restoreToolCallDefinition(toolCall)
        })
        .filter((toolCall): toolCall is RestoredToolCall => toolCall !== null)

      if (assistantContent || restoredToolCalls.length > 0) {
        const assistantMessage: AgentMessage = {
          role: 'assistant',
          content: assistantContent,
        }

        if (restoredToolCalls.length > 0) {
          assistantMessage.tool_calls = restoredToolCalls
        }

        restored.push(assistantMessage)
      }

      for (const toolCallId of currentToolCallIds) {
        const toolCall = toolCallMap.get(toolCallId)
        const toolMessage = toolCall ? this.restoreToolResultMessage(toolCall) : null
        if (toolMessage) {
          restored.push(toolMessage)
        }
      }

      currentText = ''
      currentToolCallIds = []
    }

    for (const block of contentBlocks) {
      if (!block) continue

      if (block.type === 'text') {
        currentText += typeof block.content === 'string' ? block.content : ''
        continue
      }

      if (block.type === 'tool-call') {
        if (block.toolCallId && !currentToolCallIds.includes(block.toolCallId)) {
          currentToolCallIds.push(block.toolCallId)
        }
        continue
      }

      if (block.type === 'iteration-end') {
        flushCurrentTurn()
      }
    }

    flushCurrentTurn()

    const missingToolCalls = toolCalls.filter(toolCall => toolCall.id && !consumedToolCallIds.has(toolCall.id))
    const restoredMissingToolCalls = missingToolCalls
      .map(toolCall => this.restoreToolCallDefinition(toolCall))
      .filter((toolCall): toolCall is RestoredToolCall => toolCall !== null)

    if (restoredMissingToolCalls.length > 0) {
      restored.push({
        role: 'assistant',
        content: null,
        tool_calls: restoredMissingToolCalls,
      })

      for (const toolCall of missingToolCalls) {
        const toolMessage = this.restoreToolResultMessage(toolCall)
        if (toolMessage) {
          restored.push(toolMessage)
        }
      }
    }

    return restored
  }

  private restoreAssistantMessageFallback(message: SessionMessageData): AgentMessage[] {
    const restored: AgentMessage[] = []
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : []
    const assistantContent = this.normalizeRestoredAssistantContent(
      typeof message.content === 'string' ? message.content : '',
    )
    const restoredToolCalls = toolCalls
      .map(toolCall => this.restoreToolCallDefinition(toolCall))
      .filter((toolCall): toolCall is RestoredToolCall => toolCall !== null)

    if (assistantContent || restoredToolCalls.length > 0) {
      const assistantMessage: AgentMessage = {
        role: 'assistant',
        content: assistantContent,
      }

      if (restoredToolCalls.length > 0) {
        assistantMessage.tool_calls = restoredToolCalls
      }

      restored.push(assistantMessage)
    }

    for (const toolCall of toolCalls) {
      const toolMessage = this.restoreToolResultMessage(toolCall)
      if (toolMessage) {
        restored.push(toolMessage)
      }
    }

    return restored
  }

  private restoreToolCallDefinition(toolCall: SessionToolCallData): RestoredToolCall | null {
    if (!toolCall.id || !toolCall.name) {
      return null
    }

    return {
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: typeof toolCall.arguments === 'string' ? toolCall.arguments : '{}',
      },
    }
  }

  private restoreToolResultMessage(toolCall: SessionToolCallData): AgentMessage | null {
    if (!toolCall.id || !toolCall.name) {
      return null
    }

    return {
      role: 'tool',
      content: this.buildRestoredToolResultContent(toolCall),
      tool_call_id: toolCall.id,
      name: toolCall.name,
    }
  }

  private buildRestoredToolResultContent(toolCall: SessionToolCallData): string {
    const result = typeof toolCall.result === 'string' ? toolCall.result : ''
    const error = typeof toolCall.error === 'string' ? toolCall.error : ''
    const artifactLine = toolCall.resultFilePath ? `[Full output saved to: ${toolCall.resultFilePath}]` : ''

    if (toolCall.status === 'completed') {
      const content = result || `Tool ${toolCall.name || 'unknown_tool'} completed successfully without captured output.`
      return this.truncateRestoredToolContent(artifactLine ? `${artifactLine}\n\n${content}` : content)
    }

    if (toolCall.status === 'error') {
      if (error === 'Permission denied') {
        return `Permission denied by user for: ${toolCall.name}`
      }

      const content = error || result || `Tool ${toolCall.name || 'unknown_tool'} failed without a captured error message.`
      return this.truncateRestoredToolContent(artifactLine ? `${artifactLine}\n\n${content}` : content)
    }

    if (toolCall.status === 'running' || toolCall.status === 'pending') {
      const prefix = `Tool call was interrupted before completion: ${toolCall.name || 'unknown_tool'}`
      const content = result || error ? `${prefix}\n\n${result || error}` : prefix
      return this.truncateRestoredToolContent(artifactLine ? `${artifactLine}\n\n${content}` : content)
    }

    const content = result || error || `Tool ${toolCall.name || 'unknown_tool'} finished with an unknown status.`
    return this.truncateRestoredToolContent(artifactLine ? `${artifactLine}\n\n${content}` : content)
  }

  private truncateRestoredToolContent(content: string): string {
    if (content.length <= MAX_RESTORED_TOOL_CONTENT_CHARS) {
      return content
    }

    return `${content.slice(0, MAX_RESTORED_TOOL_CONTENT_CHARS)}
[truncated]`
  }

  private normalizeRestoredAssistantContent(content: string): string | null {
    return content.trim().length > 0 ? content : null
  }

  private buildSessionMemorySystemMessage(memoryContent: string): string {
    const cleaned = (memoryContent || '').trim()
    return cleaned ? `${SESSION_MEMORY_MARKER}\n\n${cleaned}` : SESSION_MEMORY_MARKER
  }

  private isSessionMemorySystemMessage(message: AgentMessage): boolean {
    return (
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.startsWith(SESSION_MEMORY_MARKER)
    )
  }

  private buildSystemPrompt(
    workspacePath: string | null,
    permissionMode: string,
    enabledSkills: SkillData[],
  ): string {
    const workspace = workspacePath
      ? `You are working in the directory: ${workspacePath}. All file operations should be relative to or within this workspace unless the user specifies otherwise.`
      : `No workspace directory is set. You can work with files anywhere the user specifies.`

    // Environment awareness — memoize date at session-level granularity to
    // avoid unnecessary prompt changes (improves cache stability).
    const now = new Date()
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    const dateStr = `${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`
    const osName = os.platform() === 'darwin' ? 'macOS' : os.platform() === 'win32' ? 'Windows' : 'Linux'
    const homeDir = os.homedir()
    const platformHint = os.platform() === 'win32'
      ? '\nThe user is on Windows. Use Windows-compatible commands (cmd.exe or PowerShell). Use backslash paths. Common equivalents: ls->dir, cat->type, rm->del, cp->copy, mv->move, grep->findstr.\n'
      : ''

    // Skills section
    let skillsSection = ''
    if (enabledSkills.length > 0) {
      const skillsList = enabledSkills
        .map(s => `- **${s.displayName}** (\`@${s.name}\`): ${s.description}`)
        .join('\n')
      skillsSection = `\n\n## Available Skills\nUsers can explicitly invoke a skill by mentioning it in their message (for example \`@skill-name\`).\nWhen you want to use a skill proactively, call the \`invoke_skill\` tool with the exact skill name BEFORE following the skill-specific workflow.\nNever rely on mentioning \`@skill-name\` in your own assistant text to activate a skill.\nOnly load the specific skill(s) that materially help with the current task.\n${skillsList}`
    }

    return `You are Onit Agent, a highly capable AI assistant running on the user's desktop. You help users accomplish tasks by using the available tools.

Current date: ${dateStr}
OS: ${osName}
Home: ${homeDir}
${platformHint}${workspace}

# Core principles
- You represent the user and act on their behalf, never replacing their decisions.
- Be transparent about what you're doing and why.
- For complex tasks, break them down into clear steps using create_task_list.
- Try to solve problems autonomously — only ask the user when truly stuck.
- Be efficient and precise in tool usage.

# Tool usage
- ALWAYS use read_file before edit_file. Never edit a file you haven't read in this session. The edit will be rejected otherwise.
- edit_file requires old_string to be UNIQUE in the file. Include enough surrounding context (2-4 lines) to make it unambiguous.
- Use search_content for finding text/patterns in files. Do NOT use execute_command to run grep, rg, find, or cat — use the dedicated tools instead:
  - File search by name → search_files (NOT find or ls)
  - Content search → search_content (NOT grep or rg)
  - Read files → read_file (NOT cat, head, tail)
  - Edit files → edit_file (NOT sed or awk)
- For simple web content, use web_fetch. For JS-rendered pages or user interaction, use browser_navigate.
- When processing tool results, write down important facts in your response text — old tool results may be cleared from context in future turns.
- Call multiple independent read-only tools in parallel when possible for efficiency.
- Some specialized tools (browser automation, notebook editing, git worktree, interactive questions) are not loaded by default. Use tool_search to discover and load them when needed.

# Actions with care
- Freely take local, reversible actions (reading files, running tests).
- For hard-to-reverse actions (delete, force-push, overwrite), check with the user first.
- If an approach fails, diagnose the root cause before switching tactics. Don't retry the identical action blindly.
- Before installing packages or configuring tools, check if they already exist (e.g., pip show X, which X, node -v). Packages from previous sessions persist on the system.
- Never use destructive actions as a shortcut to bypass obstacles.
- For git operations: prefer new commits over amends, never force-push to main, never skip hooks.

# Permission mode: ${permissionMode}
${permissionMode === 'plan' ? `**Plan mode is active.** You MUST NOT make any edits, run any non-readonly tools, or change the system. Only read-only tools and ask_user are allowed.

## How to handle the user's words

The user's specific words (file types, technologies, tools, formats, scope, topics) are their CHOICE. Default to respecting them. But before locking them in, run three quick checks:

**1. Feasibility check** — Can what they asked actually be done?
- Yes → lock the parameter, never suggest alternatives. "I think X would be better" is NOT a reason to substitute.
- No (technically impossible / not how that tool works) → DON'T silently substitute. Tell the user the conflict and ask how to proceed. Example: "Word can't directly edit PDFs. Do you want me to use [X / Y / Z] instead?"

**2. Consistency check** — Do the user's own words contradict each other?
- Yes → ask which one is the priority. Example: "你想要的 PPT 不要任何幻灯片 — 是想要演讲稿文档（不是 PPT），还是要一个空白 PPT 模板？"
- No → continue.

**3. Likely-mistake check** — Could the user have made a typo or confused similar things?
- Strongly suggests confusion (e.g. mixing up technology names that are commonly confused) → confirm once briefly, don't offer many alternatives.
- Otherwise → trust them. People know what they want.

After all three checks pass, the parameter is LOCKED. Do not include it in any question. Do not offer options that contradict it.

## Interview workflow

1. Run the three checks above on every concrete parameter the user named.
2. If any check fails, your question is about that conflict — not about other things.
3. If all checks pass, find genuine gaps in things the user did NOT specify (style, depth, length, content preferences, optional features) and ask about those.
4. For each candidate question, verify: does it ask about a locked parameter, or include an option that contradicts one? If yes, remove it.
5. If valid questions remain, call ask_user. Otherwise skip directly to exit_plan_mode.

Your turn must end with ask_user (if you have valid questions) or exit_plan_mode (if the plan is ready). Never stop in the middle.` : ''}${permissionMode === 'accept-edit' ? `AcceptEdit mode: proceed with standard operations but ask for confirmation on sensitive ones.

When you need to clarify something with the user, prefer ask_user (interactive dialog with selectable options) over asking via natural language text. The dialog is faster and easier. Apply the same principle: respect the user's stated parameters by default; only raise conflicts if what they asked is infeasible or self-contradictory.` : ''}${permissionMode === 'full-access' ? 'Full Access mode: execute tasks autonomously, only notify about high-risk irreversible operations.' : ''}

    Format results clearly with markdown. Use syntax highlighting for code.${skillsSection}`
  }

  private buildCurrentSystemPrompt(params: {
    workspacePath: string | null
    permissionMode: string
    enabledSkills?: SkillData[]
  }): string {
    const baseSystemPrompt = this.buildSystemPrompt(
      params.workspacePath,
      params.permissionMode,
      params.enabledSkills || [],
    )
    return this.systemPromptPrepend
      ? this.systemPromptPrepend + '\n\n' + baseSystemPrompt
      : baseSystemPrompt
  }

  private refreshSessionSystemPrompt(agentSession: AgentSession): void {
    const systemPrompt = this.buildCurrentSystemPrompt({
      workspacePath: agentSession.workspacePath,
      permissionMode: agentSession.permissionMode,
      enabledSkills: agentSession.enabledSkills,
    })

    if (agentSession.messages.length > 0 && agentSession.messages[0].role === 'system') {
      agentSession.messages[0] = { role: 'system', content: systemPrompt }
    } else {
      agentSession.messages.unshift({ role: 'system', content: systemPrompt })
    }
  }

  private updatePermissionMode(agentSession: AgentSession, permissionMode: string, returnPermissionMode: string | null): void {
    agentSession.permissionMode = permissionMode
    agentSession.returnPermissionMode = returnPermissionMode
    this.refreshSessionSystemPrompt(agentSession)
    this.sendToRenderer('agent:session-update', {
      sessionId: agentSession.sessionId,
      runId: agentSession.runId,
      updates: { permissionMode },
    })
  }

  private getApiUrl(apiConfig: { billingMode: string; customBaseUrl?: string; codingPlanProvider?: string }): string {
    if (apiConfig.customBaseUrl) return apiConfig.customBaseUrl
    if (apiConfig.billingMode === 'coding-plan') {
      return this.getCodingPlanUrl(apiConfig.codingPlanProvider)
    }
    return 'https://qianfan.baidubce.com/v2/chat/completions'
  }

  private getCodingPlanUrl(provider?: string): string {
    const urls: Record<string, string> = {
      qianfan: 'https://qianfan.baidubce.com/v2/coding/chat/completions',
      volcengine: 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions',
      dashscope: 'https://coding.dashscope.aliyuncs.com/v1/chat/completions',
    }
    return urls[provider || 'qianfan'] || urls.qianfan
  }

  private getCodingPlanModel(provider?: string): string {
    const models: Record<string, string> = {
      qianfan: 'qianfan-code-latest',
      volcengine: 'ark-code-latest',
      dashscope: 'qwen3.5-plus',
    }
    return models[provider || 'qianfan'] || 'qianfan-code-latest'
  }

  private getMaxInputTokens(agentSession: AgentSession): number {
    const raw = agentSession.apiConfig.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS
    // Guardrails: avoid accidental tiny/negative configs.
    return Math.max(2000, raw)
  }

  private getMaxOutputTokens(agentSession: AgentSession): number {
    const raw = agentSession.apiConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    return Math.max(256, raw)
  }

  private getEffectiveMaxInputTokens(agentSession: AgentSession): number {
    const configured = this.getMaxInputTokens(agentSession)
    const override = agentSession.effectiveMaxInputTokens
    if (typeof override === 'number' && Number.isFinite(override)) {
      return Math.max(2000, Math.min(configured, Math.floor(override)))
    }
    return configured
  }

  private getEffectiveMaxOutputTokens(agentSession: AgentSession): number {
    const configured = this.getMaxOutputTokens(agentSession)
    const override = agentSession.effectiveMaxOutputTokens
    if (typeof override === 'number' && Number.isFinite(override)) {
      return Math.max(256, Math.min(configured, Math.floor(override)))
    }
    return configured
  }

  private getSoftWorkingSetTokens(agentSession: AgentSession): number {
    const hardMax = this.getEffectiveMaxInputTokens(agentSession)
    // Keep the soft target within the configured hard limit.
    return Math.max(2000, Math.min(SOFT_WORKING_SET_TOKENS, hardMax))
  }

  private estimateTokens(text: string): number {
    if (!text) return 0
    const bytes = Buffer.byteLength(text, 'utf-8')
    return Math.ceil(bytes / TOKEN_EST_BYTES_PER_TOKEN)
  }

  private estimateMessageTokens(message: AgentMessage): number {
    let tokens = TOKEN_EST_MESSAGE_OVERHEAD

    if (message.content) {
      tokens += this.estimateTokens(message.content)
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        tokens += TOKEN_EST_MESSAGE_OVERHEAD
        tokens += this.estimateTokens(toolCall.id || '')
        tokens += this.estimateTokens(toolCall.function?.name || '')
        tokens += this.estimateTokens(toolCall.function?.arguments || '')
      }
    }

    if (message.tool_call_id) {
      tokens += this.estimateTokens(message.tool_call_id)
    }

    if (message.name) {
      tokens += this.estimateTokens(message.name)
    }

    return tokens
  }

  private estimateMessagesTokens(messages: AgentMessage[]): number {
    return messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0)
  }

  private groupNonSystemMessages(messages: AgentMessage[]): AgentMessage[][] {
    const groups: AgentMessage[][] = []

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]

      if (msg.role === 'tool') {
        // Should not happen in well-formed history, but keep it as a standalone
        // group to avoid corrupting ordering.
        groups.push([msg])
        continue
      }

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const group: AgentMessage[] = [msg]
        let j = i + 1
        while (j < messages.length && messages[j].role === 'tool') {
          group.push(messages[j])
          j++
        }
        groups.push(group)
        i = j - 1
        continue
      }

      groups.push([msg])
    }

    return groups
  }

  private selectGroupsForTokenBudget(params: {
    agentSession: AgentSession
    systemMessages: AgentMessage[]
    nonSystemMessages: AgentMessage[]
    maxInputTokensOverride?: number
  }): { systemMessages: AgentMessage[]; keptGroups: AgentMessage[][]; droppedGroups: AgentMessage[][] } {
    const maxInputTokensRaw = params.maxInputTokensOverride ?? this.getMaxInputTokens(params.agentSession)
    const maxInputTokens = Math.max(2000, maxInputTokensRaw)
    const budget = Math.max(maxInputTokens - CONTEXT_TOKEN_SAFETY_MARGIN, 500)

    const systemMessages = [...params.systemMessages]
    let systemTokens = this.estimateMessagesTokens(systemMessages)
    if (systemTokens > budget) {
      // If system prompt + injected context already exceed the budget, truncate
      // the longest system messages (usually attachments / skills) to fit.
      const sortable = systemMessages
        .map((msg, idx) => ({ idx, msg, tokens: this.estimateMessageTokens(msg) }))
        .sort((a, b) => b.tokens - a.tokens)

      for (const entry of sortable) {
        if (systemTokens <= budget) break
        const original = entry.msg.content || ''
        if (!original) continue
        const truncated = original.slice(0, 2000) + '\n\n[truncated due to context budget]'
        systemMessages[entry.idx] = { ...entry.msg, content: truncated }
        systemTokens = this.estimateMessagesTokens(systemMessages)
      }
    }

    const remaining = Math.max(budget - systemTokens, 0)
    const groups = this.groupNonSystemMessages(params.nonSystemMessages).map((group, idx, all) => {
      const isRecent = idx >= all.length - TOOL_CONTEXT_RECENT_GROUPS
      return isRecent ? group : this.slimGroupToolOutputs(group)
    })

    const keptGroups: AgentMessage[][] = []
    let used = 0

    for (let idx = groups.length - 1; idx >= 0; idx--) {
      const group = groups[idx]
      const groupTokens = this.estimateMessagesTokens(group)

      if (keptGroups.length === 0 && groupTokens > remaining) {
        // Always keep at least the most recent group, but truncate its largest
        // message content to avoid going over budget.
        const trimmedGroup = group.map(msg => {
          if (!msg.content) return msg
          const trimmed = msg.content.slice(0, 4000) + '\n\n[truncated due to context budget]'
          return { ...msg, content: trimmed }
        })
        keptGroups.unshift(trimmedGroup)
        used = Math.min(remaining, this.estimateMessagesTokens(trimmedGroup))
        break
      }

      if (used + groupTokens > remaining) break

      keptGroups.unshift(group)
      used += groupTokens
    }

    const droppedGroups = groups.slice(0, Math.max(groups.length - keptGroups.length, 0))

    return { systemMessages, keptGroups, droppedGroups }
  }

  private pruneConversationForTokenBudget(
    agentSession: AgentSession,
    options?: { maxInputTokensOverride?: number }
  ): void {
    const systemMessages: AgentMessage[] = []
    const nonSystemMessages: AgentMessage[] = []

    for (const msg of agentSession.messages) {
      if (msg.role === 'system') systemMessages.push(msg)
      else nonSystemMessages.push(msg)
    }

    const selection = this.selectGroupsForTokenBudget({
      agentSession,
      systemMessages,
      nonSystemMessages,
      maxInputTokensOverride: options?.maxInputTokensOverride,
    })

    agentSession.messages = [...selection.systemMessages, ...selection.keptGroups.flat()]
  }

  private sanitizeArtifactComponent(input: string): string {
    return (input || 'unknown')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+/, '')
      .slice(0, 80) || 'unknown'
  }

  private getToolArtifactsDir(sessionId: string): string | null {
    if (!this.artifactsDir) return null
    const safeSessionId = this.sanitizeArtifactComponent(sessionId)
    const dirPath = path.join(this.artifactsDir, 'tool-outputs', safeSessionId)
    try {
      fs.mkdirSync(dirPath, { recursive: true })
      return dirPath
    } catch {
      return null
    }
  }

  private persistToolOutputArtifact(params: {
    sessionId: string
    toolCallId: string
    toolName: string
    output: string
  }): { filePath: string; truncated: boolean } | null {
    const dirPath = this.getToolArtifactsDir(params.sessionId)
    if (!dirPath) return null

    const safeToolCallId = this.sanitizeArtifactComponent(params.toolCallId)
    const safeToolName = this.sanitizeArtifactComponent(params.toolName)
    const filePath = path.join(dirPath, `${safeToolCallId}-${safeToolName}.txt`)

    const truncated = params.output.length > TOOL_ARTIFACT_MAX_CHARS
    const data = truncated ? params.output.slice(0, TOOL_ARTIFACT_MAX_CHARS) + '\n\n[truncated]' : params.output

    try {
      fs.writeFileSync(filePath, data, 'utf-8')
      return { filePath, truncated }
    } catch {
      return null
    }
  }

  private slimToolContentForContext(content: string, maxChars: number): string {
    const trimmed = (content || '').trim()
    if (trimmed.length <= maxChars) return trimmed

    // Prefer line-preserving truncation for logs and code.
    const lines = trimmed.split('\n')
    if (lines.length <= 1) {
      return trimmed.slice(0, maxChars) + '\n[truncated]'
    }

    const headLines: string[] = []
    const tailLines: string[] = []
    const headLimit = Math.max(Math.floor(maxChars * 0.6), 200)
    const tailLimit = Math.max(maxChars - headLimit - 80, 120)

    let headChars = 0
    for (const line of lines) {
      if (headChars + line.length + 1 > headLimit) break
      headLines.push(line)
      headChars += line.length + 1
    }

    let tailChars = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (tailChars + line.length + 1 > tailLimit) break
      tailLines.unshift(line)
      tailChars += line.length + 1
    }

    return `${headLines.join('\n')}\n...\n${tailLines.join('\n')}\n[truncated]`
  }

  private slimGroupToolOutputs(group: AgentMessage[]): AgentMessage[] {
    return group.map(msg => {
      if (msg.role !== 'tool' || !msg.content) return msg
      return {
        ...msg,
        content: this.slimToolContentForContext(msg.content, TOOL_CONTEXT_MAX_CHARS_OLD_TOOL),
      }
    })
  }

  private upsertSessionMemorySystemMessage(systemMessages: AgentMessage[], memory: SessionMemoryData | null): AgentMessage[] {
    const next = [...systemMessages]
    const idx = next.findIndex(msg => this.isSessionMemorySystemMessage(msg))

    if (!memory?.content) {
      if (idx >= 0) next.splice(idx, 1)
      return next
    }

    const memoryMessage: AgentMessage = {
      role: 'system',
      content: this.buildSessionMemorySystemMessage(memory.content),
    }

    if (idx >= 0) {
      next[idx] = memoryMessage
      return next
    }

    // Insert right after the main system prompt.
    next.splice(Math.min(1, next.length), 0, memoryMessage)
    return next
  }

  private formatGroupTranscriptForMemory(groups: AgentMessage[][]): string {
    const lines: string[] = []

    for (const group of groups) {
      for (const msg of group) {
        if (!msg) continue

        if (msg.role === 'user') {
          lines.push(`User:\n${(msg.content || '').trim()}`.trim())
          continue
        }

        if (msg.role === 'assistant') {
          const toolNames = msg.tool_calls?.map(tc => tc.function?.name).filter(Boolean) || []
          const toolHint = toolNames.length > 0 ? ` (tool_calls: ${toolNames.join(', ')})` : ''
          const content = (msg.content || '').trim()
          lines.push(`Assistant${toolHint}:\n${content}`.trim())
          continue
        }

        if (msg.role === 'tool') {
          const toolName = msg.name || 'unknown_tool'
          const content = this.slimToolContentForContext(msg.content || '', 2000)
          lines.push(`Tool[${toolName}]:\n${content}`.trim())
          continue
        }

        lines.push(`${msg.role}:\n${(msg.content || '').trim()}`.trim())
      }

      lines.push('\n---\n')
    }

    return lines.join('\n').trim()
  }

  private chunkGroupsForTokenBudget(groups: AgentMessage[][], maxTokens: number): AgentMessage[][][] {
    const chunks: AgentMessage[][][] = []
    let current: AgentMessage[][] = []
    let currentTokens = 0

    for (const group of groups) {
      const groupText = this.formatGroupTranscriptForMemory([group])
      const groupTokens = this.estimateTokens(groupText)

      if (current.length > 0 && currentTokens + groupTokens > maxTokens) {
        chunks.push(current)
        current = []
        currentTokens = 0
      }

      current.push(group)
      currentTokens += groupTokens

      // If a single group is already huge, flush it as its own chunk.
      if (currentTokens > maxTokens && current.length === 1) {
        chunks.push(current)
        current = []
        currentTokens = 0
      }
    }

    if (current.length > 0) chunks.push(current)
    return chunks
  }

  private async mergeSessionMemory(
    agentSession: AgentSession,
    currentMemory: SessionMemoryData | null,
    transcript: string,
  ): Promise<SessionMemoryData> {
    const existing = (currentMemory?.content || '').trim()
    const systemPrompt = `You are Onit Session Memory.

Your job is to compress long chat history into a high-signal, durable memory that helps the assistant work effectively in future turns.

Rules:
- Preserve important facts, decisions, constraints, and user preferences.
- Keep file paths, commands, URLs, IDs, and config values that matter.
- Do NOT copy long logs or large code blocks; summarize them.
- Deduplicate aggressively.
- Output MUST be markdown.
- Output ONLY the memory content (no preamble).
- Each section should be concise (max ~200 words). Total output should be under 2000 words.

Required structure (keep all sections, leave empty if N/A):
## Goals
What the user is trying to accomplish.
## Current State
Where we are right now — last completed step, current blocker, active file.
## Key Facts & Decisions
Important constraints, user preferences, architectural decisions.
## Files & Functions
Paths, function names, config values that will be needed again.
## Errors & Corrections
Bugs hit, fixes applied, approaches that failed.
## Work Done
Summary of completed artifacts and changes.
## Next Steps
What remains to be done.
`

    const userContent = `Existing memory (may be empty):\n\n${existing || '(none)'}\n\nNew transcript to merge:\n\n${transcript}\n`

    const { content } = agentSession.apiConfig.billingMode === 'local-model'
      ? await this.requestCompletionLocal(agentSession, {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: 0.2,
          max_tokens: SESSION_MEMORY_MAX_OUTPUT_TOKENS,
        })
      : await this.requestCompletion(agentSession, {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          stream: true,
          temperature: 0.2,
          max_tokens: SESSION_MEMORY_MAX_OUTPUT_TOKENS,
        })

    const nextContent = (content || '').trim()

    return {
      content: nextContent || existing || '',
      updatedAt: Date.now(),
      version: (currentMemory?.version || 0) + 1,
    }
  }

  private async maybeCompressSessionMemory(
    agentSession: AgentSession,
    options?: {
      maxInputTokensOverride?: number
      iteration?: number
      throttle?: {
        minIntervalMs?: number
        minIterations?: number
        minDroppedTokens?: number
        forceDroppedTokens?: number
      }
      force?: boolean
    }
  ): Promise<void> {
    const billingMode = agentSession.apiConfig.billingMode
    // Local model mode does not require an API key, but still needs Session
    // Memory compression to stay within its smaller context window.
    if (billingMode !== 'local-model' && !agentSession.apiConfig.apiKey) return
    if (agentSession.isMemoryCompressionRunning) return

    // Circuit breaker: stop trying after N consecutive failures
    if (!options?.force && agentSession.compressionFailures >= COMPRESSION_MAX_CONSECUTIVE_FAILURES) return

    // Initialization gate: don't compress short conversations
    const currentTokens = this.estimateMessagesTokens(agentSession.messages)
    agentSession.totalTokensSeen = Math.max(agentSession.totalTokensSeen, currentTokens)
    if (!options?.force && agentSession.totalTokensSeen < COMPRESSION_INIT_TOKEN_THRESHOLD) return

    // Dual trigger: require tool calls OR natural conversation break (soft only)
    if (!options?.force && options?.throttle) {
      const hasEnoughToolCalls = agentSession.toolCallsSinceLastCompression >= COMPRESSION_TOOL_CALL_THRESHOLD
      // Check if last message is a content-only assistant response (natural break)
      const lastMsg = agentSession.messages[agentSession.messages.length - 1]
      const isNaturalBreak = lastMsg?.role === 'assistant' && !lastMsg.tool_calls?.length
      if (!hasEnoughToolCalls && !isNaturalBreak) return
    }

    let systemMessages: AgentMessage[] = []
    let nonSystemMessages: AgentMessage[] = []
    for (const msg of agentSession.messages) {
      if (msg.role === 'system') systemMessages.push(msg)
      else nonSystemMessages.push(msg)
    }

    // Ensure system memory message matches the sessionMemory field.
    systemMessages = this.upsertSessionMemorySystemMessage(systemMessages, agentSession.sessionMemory)

    let memory = agentSession.sessionMemory
    let memoryChanged = false
    let compressionRan = false

    const targetMaxInputTokens = options?.maxInputTokensOverride
    const iterationIndex = options?.iteration ?? 0
    const throttle = options?.throttle

    const initialSelection = this.selectGroupsForTokenBudget({
      agentSession,
      systemMessages,
      nonSystemMessages,
      maxInputTokensOverride: targetMaxInputTokens,
    })

    const initialDroppedTokens = this.estimateMessagesTokens(initialSelection.droppedGroups.flat())

    if (initialSelection.droppedGroups.length > 0 && !options?.force && throttle) {
      const minDroppedTokens = throttle.minDroppedTokens ?? 0
      const forceDroppedTokens = throttle.forceDroppedTokens ?? Number.POSITIVE_INFINITY
      const minIntervalMs = throttle.minIntervalMs ?? 0
      const minIterations = throttle.minIterations ?? 0

      const shouldForce = initialDroppedTokens >= forceDroppedTokens
      const meetsDropThreshold = initialDroppedTokens >= minDroppedTokens
      const meetsInterval = minIntervalMs === 0 || Date.now() - agentSession.lastMemoryCompressionAt >= minIntervalMs
      const meetsIterations = minIterations === 0 || iterationIndex - agentSession.lastMemoryCompressionIteration >= minIterations

      if (!shouldForce && !(meetsDropThreshold && meetsInterval && meetsIterations)) {
        // Throttled: keep full history for now (within hard cap) so the model
        // still has access to details until we can compress into memory.
        return
      }
    }

    for (let pass = 0; pass < SESSION_MEMORY_MAX_PASSES; pass++) {
      const selection = this.selectGroupsForTokenBudget({
        agentSession,
        systemMessages,
        nonSystemMessages,
        maxInputTokensOverride: targetMaxInputTokens,
      })

      if (selection.droppedGroups.length === 0) {
        systemMessages = selection.systemMessages
        nonSystemMessages = selection.keptGroups.flat()
        break
      }

      const chunks = this.chunkGroupsForTokenBudget(selection.droppedGroups, SESSION_MEMORY_MERGE_SOURCE_MAX_TOKENS)
      agentSession.isMemoryCompressionRunning = true
      try {
        for (const chunk of chunks) {
          const transcript = this.formatGroupTranscriptForMemory(chunk)
          if (!transcript) continue
          memory = await this.mergeSessionMemory(agentSession, memory, transcript)
          memoryChanged = true
          compressionRan = true
        }
      } catch {
        // Compression is best-effort: never fail the agent loop because a
        // memory merge request failed. Keep history as-is for now.
        agentSession.compressionFailures++
        break
      } finally {
        agentSession.isMemoryCompressionRunning = false
      }

      systemMessages = this.upsertSessionMemorySystemMessage(selection.systemMessages, memory)
      nonSystemMessages = selection.keptGroups.flat()
    }

    agentSession.sessionMemory = memory
    systemMessages = this.upsertSessionMemorySystemMessage(systemMessages, memory)
    agentSession.messages = [...systemMessages, ...nonSystemMessages]

    if (compressionRan) {
      agentSession.lastMemoryCompressionAt = Date.now()
      agentSession.lastMemoryCompressionIteration = iterationIndex
      agentSession.compressionFailures = 0 // reset circuit breaker on success
      agentSession.toolCallsSinceLastCompression = 0 // reset dual trigger
    }

    if (memoryChanged) {
      this.sendToRenderer('agent:memory-update', {
        sessionId: agentSession.sessionId,
        runId: agentSession.runId,
        memory,
      })
    }
  }

  private serializeMessagesForApi(messages: AgentMessage[]): any[] {
    return messages.map(m => {
      const msg: any = { role: m.role, content: m.content }
      if (m.tool_calls) msg.tool_calls = m.tool_calls
      if (m.tool_call_id) {
        msg.tool_call_id = m.tool_call_id
        msg.name = m.name
      }
      return msg
    })
  }

  private async requestCompletion(
    agentSession: AgentSession,
    params: {
      messages: AgentMessage[]
      tools?: any[]
      stream?: boolean
      temperature?: number
      max_tokens?: number
    },
    onChunk?: (chunk: any) => void
  ): Promise<{ content: string; toolCalls: any[]; finishReason?: string | null }> {
    const url = this.getApiUrl(agentSession.apiConfig)
    const model = agentSession.apiConfig.billingMode === 'coding-plan'
      ? this.getCodingPlanModel(agentSession.apiConfig.codingPlanProvider)
      : agentSession.model

    const body = JSON.stringify({
      model,
      messages: this.serializeMessagesForApi(params.messages),
      ...(params.tools ? { tools: params.tools } : {}),
      stream: params.stream ?? true,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? this.getMaxOutputTokens(agentSession),
    })

    return new Promise((resolve, reject) => {
      if (!agentSession.isRunning) {
        reject(new Error('Agent stopped'))
        return
      }

      // Declare idleTimer at Promise scope so abort handler can clear it
      let idleTimer: ReturnType<typeof setInterval> | null = null

      const parsedUrl = new URL(url)
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${agentSession.apiConfig.apiKey}`,
        },
      }

      const httpModule = parsedUrl.protocol === 'https:' ? https : http
      const req = httpModule.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errorBody = ''
          res.on('data', (chunk: Buffer) => { errorBody += chunk.toString() })
          res.on('end', () => {
            // Include Retry-After header in error message for upstream parsing
            const retryAfter = res.headers['retry-after']
            const retryHint = retryAfter ? ` [retry-after:${retryAfter}]` : ''
            reject(new Error(`API error (${res.statusCode}): ${errorBody.substring(0, 500)}${retryHint}`))
          })
          res.on('error', reject)
          return
        }

        let fullContent = ''
        let toolCalls: any[] = []
        let buffer = ''
        let finishReason: string | null = null

        // Stream idle watchdog: abort if no data for STREAM_IDLE_TIMEOUT_MS
        let lastDataTime = Date.now()
        idleTimer = setInterval(() => {
          const idle = Date.now() - lastDataTime
          if (idle >= STREAM_IDLE_TIMEOUT_MS) {
            if (idleTimer) clearInterval(idleTimer)
            req.destroy()
            reject(new Error(`Stream idle timeout: no data for ${Math.round(idle / 1000)}s`))
          } else if (idle >= STREAM_STALL_THRESHOLD_MS) {
            // Log stall but don't abort yet
            console.warn(`[Agent] Stream stall: ${Math.round(idle / 1000)}s since last data`)
          }
        }, 5000)

        res.on('data', (chunk: Buffer) => {
          lastDataTime = Date.now()

          if (!agentSession.isRunning) {
            if (idleTimer) clearInterval(idleTimer)
            req.destroy()
            return
          }

          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (data === '[DONE]') continue

            try {
              const parsed = JSON.parse(data)
              const choice = parsed.choices?.[0]
              const delta = choice?.delta

              // Capture finish_reason when present
              if (choice?.finish_reason) finishReason = choice.finish_reason

              if (!delta) continue

              if (delta.content) {
                fullContent += delta.content
                onChunk?.({ type: 'content', content: delta.content })
              }

              if (delta.reasoning_content) {
                onChunk?.({ type: 'thinking', content: delta.reasoning_content })
              }

              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0
                  if (!toolCalls[idx]) {
                    toolCalls[idx] = {
                      id: tc.id || `call_${uuidv4().slice(0, 8)}`,
                      type: 'function',
                      function: { name: '', arguments: '' },
                    }
                  }
                  if (tc.id) toolCalls[idx].id = tc.id
                  if (tc.function?.name && !toolCalls[idx].function.name) {
                    toolCalls[idx].function.name = tc.function.name
                  }
                  if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
                }
              }
            } catch {
              // Skip invalid JSON chunks
            }
          }
        })

        res.on('end', () => {
          if (idleTimer) clearInterval(idleTimer)
          if (buffer.trim()) {
            const trimmed = buffer.trim()
            if (trimmed.startsWith('data:')) {
              const data = trimmed.slice(5).trim()
              if (data !== '[DONE]') {
                try {
                  const parsed = JSON.parse(data)
                  const delta = parsed.choices?.[0]?.delta
                  if (delta?.content) {
                    fullContent += delta.content
                    onChunk?.({ type: 'content', content: delta.content })
                  }
                  if (delta?.reasoning_content) {
                    onChunk?.({ type: 'thinking', content: delta.reasoning_content })
                  }
                  if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index ?? 0
                      if (!toolCalls[idx]) {
                        toolCalls[idx] = {
                          id: tc.id || `call_${uuidv4().slice(0, 8)}`,
                          type: 'function',
                          function: { name: '', arguments: '' },
                        }
                      }
                      if (tc.id) toolCalls[idx].id = tc.id
                      if (tc.function?.name && !toolCalls[idx].function.name) {
                        toolCalls[idx].function.name = tc.function.name
                      }
                      if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
                    }
                  }
                } catch {}
              }
            }
          }
          resolve({ content: fullContent, toolCalls: toolCalls.filter(Boolean), finishReason })
        })

        res.on('error', (err) => { if (idleTimer) clearInterval(idleTimer); reject(err) })
      })

      req.on('error', (err) => { reject(err) })

      let abortHandler: (() => void) | null = null
      if (agentSession.abortController) {
        abortHandler = () => {
          if (idleTimer) clearInterval(idleTimer)
          req.destroy()
          reject(new Error('Agent stopped'))
        }
        agentSession.abortController.signal.addEventListener('abort', abortHandler, { once: true })
      }

      const cleanupAbortHandler = () => {
        if (abortHandler && agentSession.abortController) {
          agentSession.abortController.signal.removeEventListener('abort', abortHandler)
          abortHandler = null
        }
      }

      req.on('close', cleanupAbortHandler)

      req.write(body)
      req.end()
    })
  }

  private async requestCompletionLocal(
    agentSession: AgentSession,
    params: {
      messages: AgentMessage[]
      tools?: any[]
      temperature?: number
      max_tokens?: number
    },
    onChunk?: (chunk: any) => void
  ): Promise<{ content: string; toolCalls: any[] }> {
    if (!this.localModelManager) {
      throw new Error('Local model support is not available')
    }
    const modelId = agentSession.apiConfig.localModelId
    if (!modelId) {
      throw new Error('No local model selected')
    }

    // Ensure we always run the session with its selected local model, even if
    // another session changed the currently-loaded model.
    await this.localModelManager.loadModel(modelId)

    return this.localModelManager.generateCompletion({
      messages: params.messages,
      tools: params.tools,
      temperature: params.temperature ?? 0.7,
      maxTokens: params.max_tokens ?? this.getMaxOutputTokens(agentSession),
      abortSignal: agentSession.abortController?.signal,
      expectedModelId: modelId,
      onToken: (chunk) => {
        onChunk?.(chunk)
      },
    })
  }

  private async callLLM(
    agentSession: AgentSession,
    iteration: number,
    onChunk: (chunk: any) => void
  ): Promise<{ content: string; toolCalls: any[]; finishReason?: string | null }> {
    // Start from CORE_TOOLS and add any deferred tools that were explicitly
    // loaded into this session via tool_search.
    const tools = this.toolsOverride || this.getToolsForSession(agentSession)

    if (agentSession.apiConfig.billingMode === 'local-model') {
      return this.requestCompletionLocal(
        agentSession,
        {
          messages: agentSession.messages,
          tools,
          temperature: 0.7,
          max_tokens: this.getEffectiveMaxOutputTokens(agentSession),
        },
        onChunk,
      )
    }

    return this.requestCompletionWithFallback(
      agentSession,
      {
        messages: agentSession.messages,
        tools,
        stream: true,
        temperature: 0.7,
        max_tokens: this.getEffectiveMaxOutputTokens(agentSession),
      },
      { iteration },
      onChunk,
    )
  }

  private parseApiErrorDetails(error: unknown): {
    statusCode?: number
    message: string
  } {
    const raw = error instanceof Error ? error.message : String(error)
    const match = raw.match(/API error \((\d+)\):\s*([\s\S]*)$/)
    if (!match) return { message: raw }

    const statusCode = Number(match[1])
    const bodyText = match[2]?.trim() || ''

    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText)
        const message = parsed?.error?.message || parsed?.message || bodyText
        return { statusCode, message: String(message) }
      } catch {
        // Fall through to raw body text.
      }
    }

    return { statusCode, message: bodyText || raw }
  }

  private classifyApiErrorMessage(message: string): {
    isToolFormatError: boolean
    isContextLimitError: boolean
    isMaxTokensError: boolean
  } {
    const lower = (message || '').toLowerCase()
    const has = (pattern: RegExp) => pattern.test(lower)
    const hasZh = (pattern: RegExp) => pattern.test(message || '')

    const isToolFormatError = (
      (lower.includes('tool_calls') && lower.includes('role')) ||
      (lower.includes('tool') && lower.includes('must be a response'))
    )

    const isContextLimitError = (
      (has(/context|prompt|input|token/) && has(/exceed|too long|limit|max/)) ||
      has(/context length exceeded|maximum context length|prompt is too long/) ||
      (hasZh(/上下文|输入|提示词|prompt|token/) && hasZh(/超出|超过|过长|限制|最大/))
    )

    const isMaxTokensError = (
      (has(/max_tokens|max tokens|output|completion/) && has(/exceed|too large|invalid|limit|max/)) ||
      (hasZh(/max_tokens|max tokens|输出|生成/) && hasZh(/超出|超过|过大|无效|限制|最大/))
    )

    return { isToolFormatError, isContextLimitError, isMaxTokensError }
  }

  private getNextLowerOutputTokens(current: number): number | null {
    const candidates = [65000, 32768, 16384, 8192, 4096, 2048, 1024, 512, 256]
    for (const candidate of candidates) {
      if (candidate < current) return candidate
    }
    return null
  }

  private getNextLowerInputTokens(current: number): number | null {
    const candidates = [64000, 48000, 32000, 24000, 16000, 12000, 8000, 6000, 4000, 3000, 2000]
    for (const candidate of candidates) {
      if (candidate < current) return candidate
    }
    return null
  }

  private isRetryableHttpStatus(statusCode: number): boolean {
    if (statusCode === 408 || statusCode === 429) return true
    return statusCode >= 500 && statusCode <= 599
  }

  private isRetryableNetworkError(error: unknown): boolean {
    if (error instanceof Error && error.message === 'Agent stopped') return false

    const code = (error as any)?.code
    const retryableCodes = new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ESOCKETTIMEDOUT',
      'EPIPE',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNABORTED',
    ])
    if (typeof code === 'string' && retryableCodes.has(code)) return true

    const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
    return (
      message.includes('socket hang up') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('timed out') ||
      message.includes('network socket disconnected') ||
      message.includes('client network socket disconnected') ||
      message.includes('connection closed') ||
      message.includes('connection reset')
    )
  }

  private getReconnectDelayMs(attempt: number): number {
    const exp = Math.max(0, attempt - 1)
    const base = MODEL_RECONNECT_BASE_DELAY_MS * Math.pow(2, exp)
    const delay = Math.min(MODEL_RECONNECT_MAX_DELAY_MS, Math.floor(base))
    const jitter = Math.floor(delay * MODEL_RECONNECT_JITTER_RATIO * Math.random())
    return delay + jitter
  }

  private async sleepWithAbort(agentSession: AgentSession, ms: number): Promise<void> {
    if (ms <= 0) return
    if (!agentSession.abortController) {
      await new Promise(resolve => setTimeout(resolve, ms))
      return
    }

    // Early-abort check: if already aborted, reject immediately
    if (agentSession.abortController.signal.aborted) {
      throw new Error('Agent stopped')
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, ms)

      const onAbort = () => {
        cleanup()
        reject(new Error('Agent stopped'))
      }

      const cleanup = () => {
        clearTimeout(timer)
        agentSession.abortController?.signal.removeEventListener('abort', onAbort)
      }

      agentSession.abortController.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private async requestCompletionWithFallback(
    agentSession: AgentSession,
    params: {
      messages: AgentMessage[]
      tools?: any[]
      stream?: boolean
      temperature?: number
      max_tokens?: number
    },
    options: { iteration: number },
    onChunk?: (chunk: any) => void,
  ): Promise<{ content: string; toolCalls: any[]; finishReason?: string | null }> {
    const MAX_BUDGET_ATTEMPTS = 4
    let lastError: unknown = null
    let budgetAttempts = 0
    let reconnectAttempts = 0

    let requestParams = { ...params }
    if (typeof requestParams.max_tokens !== 'number') {
      requestParams.max_tokens = this.getEffectiveMaxOutputTokens(agentSession)
    }

    while (true) {
      let emittedModelChunks = false
      const streamedOnChunk = onChunk
        ? (chunk: any) => {
            if (chunk?.type === 'content' || chunk?.type === 'thinking') {
              emittedModelChunks = true
            }
            onChunk(chunk)
          }
        : undefined

      try {
        return await this.requestCompletion(agentSession, requestParams, streamedOnChunk)
      } catch (error) {
        lastError = error
        if (!agentSession.isRunning) throw error

        const details = this.parseApiErrorDetails(error)

        const classification = this.classifyApiErrorMessage(details.message)
        if (classification.isToolFormatError) throw error

        const shouldRetryHttp = details.statusCode ? this.isRetryableHttpStatus(details.statusCode) : false
        const shouldRetryNetwork = !details.statusCode && this.isRetryableNetworkError(error)

        if (details.statusCode && (classification.isMaxTokensError || classification.isContextLimitError)) {
          let adjusted = false

          if (classification.isMaxTokensError || classification.isContextLimitError) {
            const currentOut = this.getEffectiveMaxOutputTokens(agentSession)
            const nextOut = this.getNextLowerOutputTokens(currentOut)
            if (nextOut !== null && nextOut < currentOut) {
              agentSession.effectiveMaxOutputTokens = nextOut
              requestParams = { ...requestParams, max_tokens: nextOut }
              adjusted = true
            }
          }

          if (classification.isContextLimitError) {
            const currentIn = this.getEffectiveMaxInputTokens(agentSession)
            const nextIn = this.getNextLowerInputTokens(currentIn)
            if (nextIn !== null && nextIn < currentIn) {
              agentSession.effectiveMaxInputTokens = nextIn
              adjusted = true
            }

            // Apply the new effective budgets to the prompt. Best-effort memory
            // compression first, then pruning as a last resort.
            const hardBudget = this.getEffectiveMaxInputTokens(agentSession)
            const softBudget = this.getSoftWorkingSetTokens(agentSession)

            await this.maybeCompressSessionMemory(agentSession, {
              maxInputTokensOverride: Math.min(softBudget, hardBudget),
              iteration: options.iteration,
              force: true,
            })
            await this.maybeCompressSessionMemory(agentSession, {
              maxInputTokensOverride: hardBudget,
              iteration: options.iteration,
              force: true,
            })
            this.pruneConversationForTokenBudget(agentSession, { maxInputTokensOverride: hardBudget })
            requestParams = { ...requestParams, messages: agentSession.messages }
          }

          if (!adjusted || budgetAttempts >= MAX_BUDGET_ATTEMPTS) {
            throw error
          }

          budgetAttempts++
          continue
        }

        if (shouldRetryHttp || shouldRetryNetwork) {
          reconnectAttempts++
          if (reconnectAttempts > MODEL_RECONNECT_MAX_RETRIES) {
            throw error
          }

          // Parse Retry-After from error message if present
          const retryAfterMatch = details.message.match(/\[retry-after:(\d+)\]/)
          const retryAfterSec = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : 0
          // If Retry-After > 30s, don't wait — throw so user sees the error
          if (retryAfterSec > 30) throw error
          const delayMs = retryAfterSec > 0
            ? retryAfterSec * 1000
            : this.getReconnectDelayMs(reconnectAttempts)
          const seconds = Math.max(1, Math.ceil(delayMs / 1000))
          const label = details.statusCode ? `HTTP ${details.statusCode}` : 'Network'
          const reason = (details.message || (error instanceof Error ? error.message : String(error))).trim()
          const reasonPreview = reason.length > 200 ? `${reason.slice(0, 200)}…` : reason

          // If we already streamed partial model output, roll it back to the
          // previous iteration boundary before retrying.
          if (emittedModelChunks && onChunk) {
            onChunk({ type: 'reconnect' })
          }

          if (onChunk) {
            onChunk({
              type: 'thinking',
              content: `\n[${label} error: ${reasonPreview} — reconnecting in ${seconds}s, attempt ${reconnectAttempts}/${MODEL_RECONNECT_MAX_RETRIES}]\n`,
            })
          }

          await this.sleepWithAbort(agentSession, delayMs)
          continue
        }

        throw error
      }
    }

    // Safety net (unreachable under current control flow — the while(true)
    // loop only exits via return or throw). Kept for defensive completeness.
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * Zero-cost micro-compaction: replace old tool results with stubs.
   * Only targets specific compactable tools. Keeps the most recent N results
   * intact. Mutates agentSession.messages in place.
   */
  private microcompactMessages(agentSession: AgentSession): void {
    const messages = agentSession.messages
    // Collect indices of compactable tool result messages (oldest first)
    const compactableIndices: number[] = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.role === 'tool' && msg.name && MICROCOMPACT_TOOLS.has(msg.name) && msg.content && msg.content.length > MICROCOMPACT_MAX_SUMMARY_CHARS + 50) {
        compactableIndices.push(i)
      }
    }

    // Nothing to compact if within keep-recent limit
    if (compactableIndices.length <= MICROCOMPACT_KEEP_RECENT) return

    // Replace all but the most recent N with a cleared stub
    const toClear = compactableIndices.slice(0, compactableIndices.length - MICROCOMPACT_KEEP_RECENT)
    for (const idx of toClear) {
      // Keep a short summary instead of fully clearing — preserves enough context
      // for the agent to know what was done, preventing amnesia loops.
      const original = messages[idx].content || ''
      const summary = original.substring(0, MICROCOMPACT_MAX_SUMMARY_CHARS) + '\n\n[... content trimmed, see above summary]'
      messages[idx] = { ...messages[idx], content: summary }
    }
  }

  private async prepareConversationForModelCall(agentSession: AgentSession, iteration: number): Promise<void> {
    // 0) Zero-cost micro-compaction: replace old tool results with stubs.
    this.microcompactMessages(agentSession)

    // 1) Prefer keeping calls within a soft working-set budget for speed.
    await this.maybeCompressSessionMemory(agentSession, {
      maxInputTokensOverride: this.getSoftWorkingSetTokens(agentSession),
      iteration,
      throttle: {
        minIntervalMs: SESSION_MEMORY_SOFT_MIN_INTERVAL_MS,
        minIterations: SESSION_MEMORY_SOFT_MIN_ITERATIONS,
        minDroppedTokens: SESSION_MEMORY_SOFT_MIN_DROPPED_TOKENS,
        forceDroppedTokens: SESSION_MEMORY_SOFT_FORCE_DROPPED_TOKENS,
      },
    })

    // 2) Hard guardrail: if the prompt would exceed the configured max input
    // tokens, compress history into memory instead of silently dropping it.
    const hardBudget = this.getEffectiveMaxInputTokens(agentSession)
    await this.maybeCompressSessionMemory(agentSession, {
      maxInputTokensOverride: hardBudget,
      iteration,
      force: true,
    })

    // 3) Finally, prune tool output previews / attachments and keep the prompt
    // within the hard budget before the model call.
    this.pruneConversationForTokenBudget(agentSession, {
      maxInputTokensOverride: hardBudget,
    })
  }

  private async requestPermission(
    agentSession: AgentSession,
    toolName: string,
    description: string,
    details: string,
    riskLevel: string
  ): Promise<boolean> {
    const mode = agentSession.permissionMode

    if (mode === 'full-access') {
      if (riskLevel === 'dangerous') {
        this.sendToRenderer('agent:stream', {
          sessionId: agentSession.sessionId,
          runId: agentSession.runId,
          chunk: { type: 'content', content: `\n> **Risk Notice:** Executing ${toolName} - ${description}\n\n` },
        })
      }
      return true
    }

    if (riskLevel === 'safe') return true

    if (mode === 'accept-edit' && agentSession.alwaysAllowedTools.has(toolName)) {
      return true
    }

    // Check content-level permission rules
    let ruleArgs: any = {}
    try { ruleArgs = JSON.parse(details) } catch {}
    const ruleDecision = this.checkPermissionRules(toolName, ruleArgs)
    if (ruleDecision === 'allow') return true
    if (ruleDecision === 'deny') return false

    const requestId = `${uuidv4()}:${toolName}`

    return new Promise((resolve) => {
      agentSession.pendingPermissions.set(requestId, { resolve })

      this.sendToRenderer('agent:permission-request', {
        id: requestId,
        sessionId: agentSession.sessionId,
        runId: agentSession.runId,
        type: this.getPermissionType(toolName, riskLevel),
        description,
        details,
        toolName,
        showAlwaysAllow: mode === 'accept-edit',
      })

      setTimeout(() => {
        if (agentSession.pendingPermissions.has(requestId)) {
          agentSession.pendingPermissions.delete(requestId)
          resolve(false)
        }
      }, 300000)
    })
  }

  private getPermissionType(toolName: string, riskLevel: string): string {
    if (toolName === 'delete_file') return 'file-delete'
    if (toolName === 'write_file') return 'file-write'
    if (toolName === 'edit_file') return 'file-overwrite'
    if (toolName === 'execute_command') return 'command-execute'
    return riskLevel === 'dangerous' ? 'system-config' : 'file-write'
  }

  /**
   * Ask the user structured questions via the permission dialog system.
   * Returns a formatted string of answers.
   */
  private async requestUserAnswer(agentSession: AgentSession, questions: any[]): Promise<string> {
    const requestId = `ask_user:${uuidv4()}`

    return new Promise((resolve) => {
      agentSession.pendingPermissions.set(requestId, {
        resolve: (approved: boolean) => {
          const answerText = agentSession.pendingAnswers.get(requestId)
          agentSession.pendingAnswers.delete(requestId)
          if (answerText) {
            resolve(answerText)
          } else {
            resolve(approved ? 'User approved without specific answers.' : 'User skipped the questions.')
          }
        },
      })

      this.sendToRenderer('agent:permission-request', {
        id: requestId,
        sessionId: agentSession.sessionId,
        runId: agentSession.runId,
        type: 'user-question',
        description: 'Agent is asking you a question',
        details: JSON.stringify(questions),
        toolName: 'ask_user',
        questions,
      })

      // Timeout after 5 minutes
      setTimeout(() => {
        if (agentSession.pendingPermissions.has(requestId)) {
          agentSession.pendingPermissions.delete(requestId)
          resolve('User did not respond to the questions (timed out).')
        }
      }, 300000)
    })
  }

  /**
   * Request user approval to enter plan mode.
   */
  private async requestEnterPlanMode(agentSession: AgentSession, reason: string): Promise<boolean> {
    const requestId = `enter_plan:${uuidv4()}`

    return new Promise((resolve) => {
      agentSession.pendingPermissions.set(requestId, { resolve })

      this.sendToRenderer('agent:permission-request', {
        id: requestId,
        sessionId: agentSession.sessionId,
        runId: agentSession.runId,
        type: 'task-plan',
        description: reason,
        details: '{}',
        toolName: 'enter_plan_mode',
      })

      setTimeout(() => {
        if (agentSession.pendingPermissions.has(requestId)) {
          agentSession.pendingPermissions.delete(requestId)
          resolve(false)
        }
      }, 300000)
    })
  }

  /**
   * Request plan approval via the permission dialog system.
   * Returns true if approved, false if rejected.
   */
  private async requestPlanApproval(agentSession: AgentSession, planSummary: string, keyActions: string[]): Promise<{ approved: boolean; feedback?: string }> {
    const requestId = `plan_approval:${uuidv4()}`

    // Get the last assistant message content as the full plan
    const lastAssistant = [...agentSession.messages].reverse().find(m => m.role === 'assistant')
    const planContent = lastAssistant?.content || planSummary

    return new Promise((resolve) => {
      agentSession.pendingPermissions.set(requestId, {
        resolve: (approved: boolean) => {
          const feedback = agentSession.pendingAnswers.get(requestId)
          agentSession.pendingAnswers.delete(requestId)
          resolve({ approved, feedback: feedback || undefined })
        },
      })

      this.sendToRenderer('agent:permission-request', {
        id: requestId,
        sessionId: agentSession.sessionId,
        runId: agentSession.runId,
        type: 'plan-approval',
        description: planSummary,
        details: JSON.stringify(keyActions),
        toolName: 'exit_plan_mode',
        planContent,
        planFiles: keyActions,
      })

      // Timeout after 10 minutes (plans need more review time)
      setTimeout(() => {
        if (agentSession.pendingPermissions.has(requestId)) {
          agentSession.pendingPermissions.delete(requestId)
          resolve({ approved: false })
        }
      }, 600000)
    })
  }

  /**
   * Handle interactive responses from the renderer (questions / plan approval).
   * Called from main.ts IPC handler.
   */
  handleQuestionResponse(requestId: string, approved: boolean, answerText?: string): void {
    for (const [, session] of this.sessions) {
      const pending = session.pendingPermissions.get(requestId)
      if (pending) {
        if (typeof answerText === 'string') {
          session.pendingAnswers.set(requestId, answerText)
        }
        pending.resolve(approved)
        session.pendingPermissions.delete(requestId)
        return
      }
    }
  }

  private async runAgentLoop(agentSession: AgentSession): Promise<void> {
    const MAX_ITERATIONS = 200
    let iteration = 0

    let maxOutputRecoveryCount = 0

    try {
      while (agentSession.isRunning && iteration < MAX_ITERATIONS) {
        iteration++

        // After 50 iterations, add a hint to encourage progress summary
        if (iteration === 51) {
          agentSession.messages.push({
            role: 'system',
            content: 'You have been running for a while. Please summarize your progress so far and outline what remains to be done. If you are stuck in a loop, try a different approach.',
          })
        }

        // Keep prompt within budgets (soft working-set + hard cap) before each
        // model call. This is where Session Memory compression happens.
        await this.prepareConversationForModelCall(agentSession, iteration)

        // Call LLM
        const { content, toolCalls, finishReason } = await this.callLLM(agentSession, iteration, (chunk) => {
          this.sendToRenderer('agent:stream', {
            sessionId: agentSession.sessionId,
            runId: agentSession.runId,
            chunk,
          })
        })

        if (!agentSession.isRunning) break

        // max_output_tokens recovery: if truncated and no tool calls, inject
        // a meta-prompt telling the model to resume
        if (toolCalls.length === 0 && finishReason === 'length' && maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
          maxOutputRecoveryCount++
          agentSession.messages.push({ role: 'assistant', content: content || '' })
          agentSession.messages.push({ role: 'user', content: MAX_OUTPUT_RECOVERY_PROMPT })
          continue // retry the loop with the recovery prompt
        }

        // If there's content and no tool calls, we're done
        if (toolCalls.length === 0) {
          agentSession.messages.push({ role: 'assistant', content: content || '' })
          agentSession.completionStatus = 'completed'
          break
        }

        // Reset recovery counter on successful tool-use turns
        maxOutputRecoveryCount = 0

        // Add assistant message with tool calls
        agentSession.messages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls,
        })

        // Partition tool calls into batches: consecutive concurrency-safe
        // tools form parallel batches; non-safe tools run serially.
        type ToolBatch = { concurrent: boolean; calls: typeof toolCalls }
        const batches: ToolBatch[] = []
        for (const tc of toolCalls) {
          const safe = isToolConcurrencySafe(tc.function.name)
          const lastBatch = batches[batches.length - 1]
          if (lastBatch && lastBatch.concurrent && safe) {
            lastBatch.calls.push(tc) // merge into current concurrent batch
          } else {
            batches.push({ concurrent: safe, calls: [tc] })
          }
        }

        // Execute batches
        for (const batch of batches) {
          if (!agentSession.isRunning) break

          const executeSingleTool = async (tc: typeof toolCalls[0]) => {
            const toolName = tc.function.name
            const toolArgs = tc.function.arguments

            this.sendToRenderer('agent:stream', {
              sessionId: agentSession.sessionId,
              runId: agentSession.runId,
              chunk: { type: 'tool-call-start', toolCall: { id: tc.id, name: toolName, arguments: toolArgs, status: 'running' } },
            })

            // Check permissions BEFORE executing
            let args: any = {}
            try { args = JSON.parse(toolArgs) } catch {}
            const riskLevel = getToolRiskLevel(toolName, args)

            if (riskLevel !== 'safe') {
              const description = `${toolName}: ${args.path || args.command || ''}`
              const approved = await this.requestPermission(
                agentSession, toolName, description, toolArgs, riskLevel
              )

              if (!approved) {
                return {
                  tc, toolName, toolArgs,
                  result: { success: false, output: `Permission denied by user for: ${toolName}`, riskLevel: 'safe' as const },
                  denied: true,
                }
              }
            }

            // --- Interactive tools: enter_plan_mode, ask_user, exit_plan_mode ---
            if (toolName === 'enter_plan_mode' && !this.toolExecutorOverride) {
              if (agentSession.permissionMode === 'plan') {
                return {
                  tc, toolName, toolArgs,
                  result: { success: true, output: 'Already in plan mode.', riskLevel: 'safe' as const },
                  denied: false,
                }
              }
              try {
                const planArgs = JSON.parse(toolArgs)
                const approved = await this.requestEnterPlanMode(agentSession, planArgs.reason || 'Task requires planning')
                if (approved) {
                  const previousMode = agentSession.permissionMode === 'plan'
                    ? agentSession.returnPermissionMode
                    : agentSession.permissionMode
                  this.updatePermissionMode(agentSession, 'plan', previousMode)
                  return {
                    tc, toolName, toolArgs,
                    result: { success: true, output: 'User approved entering plan mode. You are now in plan mode — only read-only tools and ask_user are allowed. Explore the codebase, ask clarifying questions, then call exit_plan_mode with your plan.', riskLevel: 'safe' as const },
                    denied: false,
                  }
                } else {
                  return {
                    tc, toolName, toolArgs,
                    result: { success: false, output: 'User declined to enter plan mode. Proceed with implementation directly.', riskLevel: 'safe' as const },
                    denied: false,
                  }
                }
              } catch (e: any) {
                return {
                  tc, toolName, toolArgs,
                  result: { success: false, output: `Failed: ${e.message}`, riskLevel: 'safe' as const },
                  denied: false,
                }
              }
            }

            if (toolName === 'ask_user') {
              try {
                const askArgs = JSON.parse(toolArgs)
                const questions = askArgs.questions || []
                const answer = await this.requestUserAnswer(agentSession, questions)
                return {
                  tc, toolName, toolArgs,
                  result: { success: true, output: answer, riskLevel: 'safe' as const },
                  denied: false,
                }
              } catch (e: any) {
                return {
                  tc, toolName, toolArgs,
                  result: { success: false, output: `Failed to ask user: ${e.message}`, riskLevel: 'safe' as const },
                  denied: false,
                }
              }
            }

            if (toolName === 'exit_plan_mode' && !this.toolExecutorOverride) {
              try {
                const planArgs = JSON.parse(toolArgs)
                const planResult = await this.requestPlanApproval(agentSession, planArgs.planSummary || '', planArgs.keyActions || planArgs.filesToModify || [])
                if (planResult.approved) {
                  const nextMode = agentSession.returnPermissionMode && agentSession.returnPermissionMode !== 'plan'
                    ? agentSession.returnPermissionMode
                    : 'accept-edit'
                  this.updatePermissionMode(agentSession, nextMode, null)
                  return {
                    tc, toolName, toolArgs,
                    result: { success: true, output: `User approved your plan. You can now start implementing. Permission mode switched to ${nextMode}.`, riskLevel: 'safe' as const },
                    denied: false,
                  }
                } else {
                  const feedbackMsg = planResult.feedback
                    ? `User rejected the plan with feedback: "${planResult.feedback}". Refine your plan based on this feedback.`
                    : 'User rejected the plan. Continue refining — ask the user what they want changed.'
                  return {
                    tc, toolName, toolArgs,
                    result: { success: false, output: feedbackMsg, riskLevel: 'safe' as const },
                    denied: false,
                  }
                }
              } catch (e: any) {
                return {
                  tc, toolName, toolArgs,
                  result: { success: false, output: `Plan approval failed: ${e.message}`, riskLevel: 'safe' as const },
                  denied: false,
                }
              }
            }

            if (toolName === 'invoke_skill') {
              const invocation = this.loadSkillIntoSession(
                agentSession,
                typeof args.skill_name === 'string' ? args.skill_name : (typeof args.skill === 'string' ? args.skill : ''),
              )
              return {
                tc, toolName, toolArgs,
                result: {
                  success: invocation.success,
                  output: invocation.output,
                  riskLevel: 'safe' as const,
                },
                postToolMessages: invocation.injectedMessage ? [invocation.injectedMessage] : [],
                denied: false,
              }
            }

            if (toolName === 'tool_search') {
              const query = typeof args.query === 'string' ? args.query : ''
              const matches = searchTools(query)
              const availableDeferredTools = searchTools('').map(tool => tool.function.name)
              for (const match of matches) {
                agentSession.loadedDeferredToolNames.add(match.function.name)
              }

              const output = matches.length === 0
                ? `No tools found matching "${query}". Available deferred tools: ${availableDeferredTools.join(', ')}`
                : `Loaded ${matches.length} deferred tool(s) for future calls: ${matches.map(tool => tool.function.name).join(', ')}\n\nThese tools will be callable in your next response.`

              return {
                tc, toolName, toolArgs,
                result: { success: true, output, riskLevel: 'safe' as const },
                postToolMessages: [],
                denied: false,
              }
            }

            // --- Plan mode: enforce read-only (except plan file) ---
            if (agentSession.permissionMode === 'plan' && !this.toolExecutorOverride) {
              const readOnlyTools = new Set([
                'read_file', 'list_directory', 'search_files', 'search_content',
                'create_task_list', 'web_search', 'web_fetch',
                'browser_navigate', 'browser_extract', 'browser_screenshot', 'browser_close',
                'ask_user', 'exit_plan_mode', 'find_symbol', 'tool_search', 'invoke_skill',
              ])
              if (!readOnlyTools.has(toolName)) {
                return {
                  tc, toolName, toolArgs,
                  result: { success: false, output: `Tool "${toolName}" is not allowed in plan mode. Only read-only tools, ask_user, and exit_plan_mode are permitted. Use exit_plan_mode to submit your plan for approval before making changes.`, riskLevel: 'safe' as const },
                  denied: false,
                }
              }
            }

            // Read-before-edit enforcement: reject edits to files not read in this session
            if (toolName === 'edit_file' && !this.toolExecutorOverride) {
              try {
                const editArgs = JSON.parse(toolArgs)
                if (editArgs.path && !agentSession.readFiles.has(path.resolve(editArgs.path))) {
                  return {
                    tc, toolName, toolArgs,
                    result: { success: false, output: `You must read_file "${editArgs.path}" before editing it. This prevents edits based on stale or hallucinated content.`, riskLevel: 'safe' as const },
                    denied: false,
                  }
                }
              } catch {}
            }

            // Run preToolUse hooks
            const hookCtx = { toolName, toolArgs, sessionId: agentSession.sessionId, workspacePath: agentSession.workspacePath }
            if (this.hooksManager.hasHooks()) {
              const hookDecision = await this.hooksManager.runPreToolUse(hookCtx)
              if (hookDecision === 'deny') {
                return {
                  tc, toolName, toolArgs,
                  result: { success: false, output: `Blocked by preToolUse hook`, riskLevel: 'safe' as const },
                  denied: true,
                }
              }
            }

            // Execute the tool
            let result: any
            if (toolName.startsWith('browser_') && !this.toolExecutorOverride) {
              if (!agentSession.browserManager) {
                agentSession.browserManager = new BrowserManager({
                  apiConfig: agentSession.apiConfig,
                  artifactsDir: this.artifactsDir || undefined,
                  sessionId: agentSession.sessionId,
                })
              }
              result = await agentSession.browserManager.handleToolCall(toolName, toolArgs)
            } else {
              const executeToolFn = this.toolExecutorOverride || executeTool
              result = await executeToolFn(toolName, toolArgs, agentSession.workspacePath, {
                signal: agentSession.abortController?.signal,
              })
            }

            // Track read files for read-before-edit enforcement
            if (toolName === 'read_file' && result.success) {
              try {
                const readArgs = JSON.parse(toolArgs)
                if (readArgs.path) agentSession.readFiles.add(path.resolve(readArgs.path))
              } catch {}
            }

            // Run postToolUse hooks (fire-and-forget)
            if (this.hooksManager.hasHooks()) {
              this.hooksManager.runPostToolUse({ ...hookCtx, toolResult: result.output }).catch(() => {})
            }

            return { tc, toolName, toolArgs, result, postToolMessages: [], denied: false }
          }

          // Run batch: parallel for concurrent-safe (>1), serial otherwise
          let results: Awaited<ReturnType<typeof executeSingleTool>>[]
          if (batch.concurrent && batch.calls.length > 1) {
            results = await Promise.all(batch.calls.map(executeSingleTool))
          } else {
            results = []
            for (const tc of batch.calls) {
              if (!agentSession.isRunning) break
              results.push(await executeSingleTool(tc))
            }
          }

          // Process results in original order
          for (const r of results) {
            if (!r) continue
            const { tc, toolName, toolArgs, result, postToolMessages, denied } = r

            if (denied) {
              agentSession.messages.push({
                role: 'tool',
                content: `Permission denied by user for: ${toolName}`,
                tool_call_id: tc.id,
                name: toolName,
              })
              this.sendToRenderer('agent:stream', {
                sessionId: agentSession.sessionId,
                runId: agentSession.runId,
                chunk: {
                  type: 'tool-call-result',
                  toolCall: { id: tc.id, name: toolName, arguments: toolArgs, status: 'error', error: 'Permission denied' },
                },
              })
              continue
            }

            // Handle task list updates
            if (toolName === 'create_task_list') {
              try {
                const tasks = JSON.parse(result.output)
                this.sendToRenderer('agent:task-update', {
                  sessionId: agentSession.sessionId,
                  runId: agentSession.runId,
                  tasks,
                })
              } catch {}
            }

            // Update workspace files if file operations were performed
            if (['write_file', 'delete_file', 'edit_file'].includes(toolName) && agentSession.workspacePath) {
              this.updateWorkspaceFiles(agentSession)
            }

            const shouldPersistArtifact = result.output.length > TOOL_CONTEXT_MAX_CHARS_DEFAULT
            const artifact = shouldPersistArtifact
              ? this.persistToolOutputArtifact({
                  sessionId: agentSession.sessionId,
                  toolCallId: tc.id,
                  toolName,
                  output: result.output,
                })
              : null

            const contextMaxChars = ['read_file', 'web_fetch'].includes(toolName)
              ? TOOL_CONTEXT_MAX_CHARS_LARGE_TEXT
              : TOOL_CONTEXT_MAX_CHARS_DEFAULT

            const toolContent = (() => {
              const preview = this.slimToolContentForContext(result.output, contextMaxChars)
              if (!artifact) return preview
              const suffix = artifact.truncated ? ' (truncated)' : ''
              return `[Full output saved to: ${artifact.filePath}${suffix}]\n\n${preview}`
            })()

            // Add tool result to conversation (bounded for context window)
            agentSession.messages.push({
              role: 'tool',
              content: toolContent,
              tool_call_id: tc.id,
              name: toolName,
            })

            for (const injectedMessage of postToolMessages || []) {
              agentSession.messages.push(injectedMessage)
            }

            // Notify about tool call completion
            this.sendToRenderer('agent:stream', {
              sessionId: agentSession.sessionId,
              runId: agentSession.runId,
              chunk: {
                type: 'tool-call-result',
                toolCall: {
                  id: tc.id,
                  name: toolName,
                  arguments: toolArgs,
                  status: result.success ? 'completed' : 'error',
                  result: this.slimToolContentForContext(result.output, 2000),
                  error: result.success ? undefined : this.slimToolContentForContext(result.output, 2000),
                  resultFilePath: artifact?.filePath,
                },
              },
            })
          }
        }

        // Track tool calls for dual-trigger compression
        agentSession.toolCallsSinceLastCompression += toolCalls.length

        // Send iteration-end signal for UI collapse
        this.sendToRenderer('agent:stream', {
          sessionId: agentSession.sessionId,
          runId: agentSession.runId,
          chunk: { type: 'iteration-end', iterationIndex: iteration },
        })
      }
    } catch (error: any) {
      if (error.message !== 'Agent stopped') {
        agentSession.completionStatus = 'error'
        this.sendToRenderer('agent:error', {
          sessionId: agentSession.sessionId,
          runId: agentSession.runId,
          error: error.message || 'Unknown error in agent loop',
        })
      }
    } finally {
      agentSession.isRunning = false

      // Close browser if it was used in this session
      if (agentSession.browserManager) {
        agentSession.browserManager.close().catch(() => {})
        agentSession.browserManager = undefined
      }

      if (agentSession.completionStatus !== 'error') {
        this.sendToRenderer('agent:complete', {
          sessionId: agentSession.sessionId,
          runId: agentSession.runId,
          status: agentSession.completionStatus,
        })
      }

      // Fire-and-forget: notify evolution system about used skills.
      // currentRunSkillNames: skills used in THIS run (distance=0) → for usage count
      // sessionSkillNames: skills within recording window (distance≤2) → for evolution recording
      const EVOLUTION_RECORD_MAX_RUN_DISTANCE = 2
      const currentRunSkillNames: string[] = []
      const sessionSkillNames: string[] = []
      for (const [name, runsAgo] of agentSession.usedSkillNames) {
        if (runsAgo === 0) currentRunSkillNames.push(name)
        if (runsAgo <= EVOLUTION_RECORD_MAX_RUN_DISTANCE) sessionSkillNames.push(name)
      }
      if (this.onRunComplete && sessionSkillNames.length > 0) {
        try {
          this.onRunComplete({
            sessionId: agentSession.sessionId,
            runId: agentSession.runId,
            currentRunSkillNames,
            sessionSkillNames,
            messages: agentSession.messages,
            apiConfig: agentSession.apiConfig,
          })
        } catch { /* never let evolution tracking break the main flow */ }
      }

      // Schedule session cleanup: remove from map after 10 minutes of inactivity
      // to prevent memory leaks. If startAgent is called again for this sessionId,
      // the session will be re-created.
      const cleanupSessionId = agentSession.sessionId
      setTimeout(() => {
        const current = this.sessions.get(cleanupSessionId)
        if (current && !current.isRunning) {
          this.sessions.delete(cleanupSessionId)
        }
      }, 10 * 60 * 1000)
    }
  }

  private updateWorkspaceFiles(agentSession: AgentSession): void {
    if (!agentSession.workspacePath) return
    try {
      const entries = fs.readdirSync(agentSession.workspacePath, { withFileTypes: true })
      const files = entries
        .filter((e: any) => !e.name.startsWith('.'))
        .map((e: any) => ({
          name: e.name,
          path: path.join(agentSession.workspacePath!, e.name),
          type: e.isDirectory() ? 'directory' : 'file',
        }))
      this.sendToRenderer('agent:workspace-files', {
        sessionId: agentSession.sessionId,
        runId: agentSession.runId,
        files,
      })
    } catch {}
  }
}
