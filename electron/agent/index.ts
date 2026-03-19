import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { URL } from 'url'
import { v4 as uuidv4 } from 'uuid'
import { executeTool, AGENT_TOOLS, getToolRiskLevel } from './tools'
import { AgentMessage } from './types'
import type { LocalModelManager } from '../local-model/index'

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

interface AgentSession {
  sessionId: string
  runId: string
  messages: AgentMessage[]
  abortController: AbortController | null
  isRunning: boolean
  completionStatus: 'completed' | 'stopped' | 'error'
  permissionMode: string
  workspacePath: string | null
  model: string
  sessionMemory: SessionMemoryData | null
  effectiveMaxInputTokens?: number
  effectiveMaxOutputTokens?: number
  lastMemoryCompressionAt: number
  lastMemoryCompressionIteration: number
  isMemoryCompressionRunning: boolean
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
  /** Maps skill name → how many runs ago it was last @-mentioned (0 = this run). */
  usedSkillNames: Map<string, number>
  runPromise?: Promise<void>
}

export class AgentManager {
  private sessions: Map<string, AgentSession> = new Map()
  private sendToRenderer: (channel: string, data: any) => void
  private artifactsDir: string | null
  private localModelManager: LocalModelManager | null
  private onRunComplete: ((params: {
    sessionId: string
    runId: string
    /** Skills @-mentioned in this run's user message (for usage count). */
    currentRunSkillNames: string[]
    /** All skills @-mentioned within the recording window (for evolution recording). */
    sessionSkillNames: string[]
    messages: AgentMessage[]
    apiConfig: AgentSession['apiConfig']
  }) => void) | null = null

  constructor(
    sendToRenderer: (channel: string, data: any) => void,
    options?: {
      artifactsDir?: string
      localModelManager?: LocalModelManager
      onRunComplete?: AgentManager['onRunComplete']
    }
  ) {
    this.sendToRenderer = sendToRenderer
    this.artifactsDir = options?.artifactsDir || null
    this.localModelManager = options?.localModelManager || null
    this.onRunComplete = options?.onRunComplete || null
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
    const attachedFileMessages = this.buildAttachedFileMessages(sessionData.attachedFiles || [])

    // Parse @skill-name mentions from user message and inject skill content
    const { contents: mentionedSkillContents, names: mentionedSkillNames } = this.extractMentionedSkills(userMessage, enabledSkills)

    // Build the system prompt
    const systemPrompt = this.buildSystemPrompt(
      sessionData.workspacePath,
      sessionData.permissionMode,
      enabledSkills,
    )

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
      workspacePath: sessionData.workspacePath,
      model: sessionData.model || 'qianfan-code-latest',
      sessionMemory,
      effectiveMaxInputTokens: undefined,
      effectiveMaxOutputTokens: undefined,
      lastMemoryCompressionAt: 0,
      lastMemoryCompressionIteration: 0,
      isMemoryCompressionRunning: false,
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
      alwaysAllowedTools: agentSession?.alwaysAllowedTools || new Set(),
      pendingPermissions: new Map(),
      enabledSkills,
      usedSkillNames: new Map<string, number>(),
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
    }
    return true
  }

  stopAll(): void {
    for (const [sessionId] of this.sessions) {
      this.stopAgent(sessionId)
    }
  }

  handlePermissionResponse(requestId: string, approved: boolean, alwaysAllow?: boolean): void {
    for (const [, session] of this.sessions) {
      const pending = session.pendingPermissions.get(requestId)
      if (pending) {
        if (alwaysAllow && approved) {
          const parts = requestId.split(':')
          if (parts.length > 1) {
            session.alwaysAllowedTools.add(parts[1])
          }
        }
        pending.resolve(approved)
        session.pendingPermissions.delete(requestId)
        return
      }
    }
  }

  private extractMentionedSkills(message: string, enabledSkills: SkillData[]): { contents: string[]; names: string[] } {
    const contents: string[] = []
    const names: string[] = []
    const mentionPattern = /@([\w-]+)/g
    let match: RegExpExecArray | null

    while ((match = mentionPattern.exec(message)) !== null) {
      const skillName = match[1]
      const skill = enabledSkills.find(s => s.name === skillName)
      if (skill && skill.content) {
        // Compose skill content with memory overlay
        let fullContent = skill.content
        if (skill.memory) {
          fullContent += '\n\n## Skill Memory\n\n' + skill.memory
        }
        const injected = fullContent.length > 5000
          ? fullContent.substring(0, 5000) + '\n\n[Skill content truncated]'
          : fullContent
        contents.push(`[Skill: ${skill.displayName}]\n\n${injected}`)
        names.push(skill.name)
      }
    }

    return { contents, names }
  }

  private buildAttachedFileMessages(attachedFiles: string[]): AgentMessage[] {
    const messages: AgentMessage[] = []
    let totalChars = 0

    for (const filePath of attachedFiles.slice(0, MAX_ATTACHED_FILES)) {
      try {
        if (!fs.existsSync(filePath)) {
          messages.push({
            role: 'system',
            content: `[Attached File Unavailable]\n\nThe user attached this file, but it could not be found: ${filePath}`,
          })
          continue
        }

        const stat = fs.statSync(filePath)
        if (!stat.isFile()) continue

        const remainingChars = MAX_TOTAL_ATTACHED_CHARS - totalChars
        if (remainingChars <= 0) break

        const content = fs.readFileSync(filePath, 'utf-8')
        const cap = Math.min(MAX_ATTACHED_FILE_CHARS, remainingChars)
        const truncated = content.length > cap
        const excerpt = truncated ? `${content.slice(0, cap)}\n\n[Attached file truncated]` : content

        totalChars += excerpt.length
        messages.push({
          role: 'system',
          content: `[Attached File: ${filePath}]\n\n${excerpt}`,
        })
      } catch {
        messages.push({
          role: 'system',
          content: `[Attached File Unreadable]\n\nThe user attached this file, but it could not be decoded as text: ${filePath}`,
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

    // Environment awareness
    const now = new Date()
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    const dateStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}, ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
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
      skillsSection = `\n\n## Available Skills\nThe user can invoke these skills by mentioning them with @. When a skill is mentioned, follow its instructions.\n${skillsList}`
    }

    return `You are Onit Agent, a highly capable AI assistant running on the user's desktop. You help users accomplish tasks by using the available tools.

Current date and time: ${dateStr}
Operating system: ${osName}
Home directory: ${homeDir}
${platformHint}
${workspace}

Core principles:
- You represent the user and act on their behalf, never replacing their decisions
- Be transparent about what you're doing and why
- For complex tasks, break them down into clear steps using create_task_list
- Always explain your reasoning before taking actions
- Try to solve problems autonomously — only ask the user for help when you encounter truly insurmountable obstacles
- Be efficient and precise in tool usage

Current permission mode: ${permissionMode}
${permissionMode === 'plan' ? 'In Plan mode: explain every step before executing and ask for confirmation on uncertain operations.' : ''}
${permissionMode === 'accept-edit' ? 'In AcceptEdit mode: proceed with standard operations but ask for confirmation on sensitive ones.' : ''}
${permissionMode === 'full-access' ? 'In Full Access mode: execute tasks autonomously, only notify about high-risk irreversible operations.' : ''}

When providing final results, format them clearly with markdown. For code, use appropriate syntax highlighting.${skillsSection}`
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
    const systemPrompt = `You are Onit Session Memory.\n\nYour job is to compress long chat history into a high-signal, durable memory that helps the assistant work effectively in future turns.\n\nRules:\n- Preserve important facts, decisions, constraints, and user preferences.\n- Keep file paths, commands, URLs, IDs, and config values that matter.\n- Do NOT copy long logs or large code blocks; summarize them.\n- Deduplicate aggressively.\n- Output MUST be markdown.\n- Output ONLY the memory content (no preamble).\n\nRecommended structure:\n## Goals\n## User Preferences\n## Key Facts & Decisions\n## Work Done (artifacts/files)\n## Open Questions / Next Steps\n`

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
  ): Promise<{ content: string; toolCalls: any[] }> {
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
            reject(new Error(`API error (${res.statusCode}): ${errorBody.substring(0, 500)}`))
          })
          res.on('error', reject)
          return
        }

        let fullContent = ''
        let toolCalls: any[] = []
        let buffer = ''

        res.on('data', (chunk: Buffer) => {
          if (!agentSession.isRunning) {
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
              const delta = parsed.choices?.[0]?.delta

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
          resolve({ content: fullContent, toolCalls: toolCalls.filter(Boolean) })
        })

        res.on('error', reject)
      })

      req.on('error', reject)

      let abortHandler: (() => void) | null = null
      if (agentSession.abortController) {
        abortHandler = () => {
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
  ): Promise<{ content: string; toolCalls: any[] }> {
    if (agentSession.apiConfig.billingMode === 'local-model') {
      return this.requestCompletionLocal(
        agentSession,
        {
          messages: agentSession.messages,
          tools: AGENT_TOOLS,
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
        tools: AGENT_TOOLS,
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
  ): Promise<{ content: string; toolCalls: any[] }> {
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

          const delayMs = this.getReconnectDelayMs(reconnectAttempts)
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

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async prepareConversationForModelCall(agentSession: AgentSession, iteration: number): Promise<void> {
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
    await this.maybeCompressSessionMemory(agentSession, {
      maxInputTokensOverride: this.getEffectiveMaxInputTokens(agentSession),
      iteration,
      force: true,
    })

    // 3) Finally, prune tool output previews / attachments and keep the prompt
    // within the hard budget before the model call.
    this.pruneConversationForTokenBudget(agentSession, {
      maxInputTokensOverride: this.getEffectiveMaxInputTokens(agentSession),
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

  private async runAgentLoop(agentSession: AgentSession): Promise<void> {
    const MAX_ITERATIONS = 200
    let iteration = 0

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
        const { content, toolCalls } = await this.callLLM(agentSession, iteration, (chunk) => {
          this.sendToRenderer('agent:stream', {
            sessionId: agentSession.sessionId,
            runId: agentSession.runId,
            chunk,
          })
        })

        if (!agentSession.isRunning) break

        // If there's content and no tool calls, we're done
        if (toolCalls.length === 0) {
          agentSession.messages.push({ role: 'assistant', content: content || '' })
          agentSession.completionStatus = 'completed'
          break
        }

        // Add assistant message with tool calls
        agentSession.messages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls,
        })

        // Execute each tool call
        for (const tc of toolCalls) {
          if (!agentSession.isRunning) break

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
          }

          // Execute the tool
          const result = await executeTool(toolName, toolArgs, agentSession.workspacePath, {
            signal: agentSession.abortController?.signal,
          })

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
      if (agentSession.completionStatus !== 'error') {
        this.sendToRenderer('agent:complete', {
          sessionId: agentSession.sessionId,
          runId: agentSession.runId,
          status: agentSession.completionStatus,
        })
      }

      // Fire-and-forget: notify evolution system about used skills.
      // currentRunSkillNames: skills @-mentioned in THIS run (distance=0) → for usage count
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
