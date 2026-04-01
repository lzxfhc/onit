import os from 'os'
import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { AgentManager } from '../agent/index'
import type { SkillManager } from '../agent/skills'
import type { LocalModelManager } from '../local-model/index'
import type { Message, SessionMemory, StreamChunk } from '../../src/types'
import { COPILOT_TOOLS, executeCopilotTool } from './tools'
import {
  CopilotTask,
  loadMainConversation,
  saveMainConversation,
  loadTasks,
  saveTask,
  deleteTask as deleteTaskFile,
  buildContextInjection,
} from './memory'
import {
  applyTaskError,
  applyTaskStreamChunks,
  buildTaskRunMessages,
  completeTaskRun,
  extractTaskResult,
} from './task-messages'

export type { CopilotTask } from './memory'

// ---------------------------------------------------------------------------
// Simple topic fallback — no regex classification, just word extraction
// ---------------------------------------------------------------------------

/** Generate a simple topic slug from description when LLM doesn't provide one. */
function generateSimpleTopic(description: string): string {
  const words = description
    .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1)
    .slice(0, 3)
  return words.join('-').toLowerCase().substring(0, 30) || 'general'
}

/** Normalize a topic string for fuzzy matching. */
function normalizeTopic(topic: string): string {
  return topic.toLowerCase().replace(/[-_\s]+/g, '')
}

const TASK_CHUNK_FLUSH_MS = 80
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_RETENTION_MS = 30 * DAY_MS

export class CopilotManager {
  private sendToRenderer: (channel: string, data: any) => void
  private workerAgent: AgentManager
  private skillManager: SkillManager | null
  private dataDir: string
  private localModelManager: LocalModelManager | null

  /** The orchestrator's own AgentManager (uses copilot tools + Onit prompt). */
  private orchestratorAgent: AgentManager | null = null

  /** Orchestrator's compressed memory — survives across AgentManager rebuilds. */
  private orchestratorSessionMemory: { content: string; updatedAt: number; version?: number } | null = null

  /** In-memory task registry. Loaded from disk on startup, saved on changes. */
  private tasks: Map<string, CopilotTask> = new Map()

  /** Current API config for the orchestrator. */
  private apiConfig: any = {}

  /** Shared scratchpad directory for cross-worker knowledge exchange. */
  private scratchpadDir: string | null = null

  /** The orchestrator's current run ID, so we can detect completion. */
  private currentRunId: string | null = null

  /** Buffered worker chunks per task to avoid flooding disk/UI on every token. */
  private pendingTaskChunks: Map<string, { runId: string; chunks: StreamChunk[] }> = new Map()

  private pendingTaskChunkTimers: Map<string, NodeJS.Timeout> = new Map()

  constructor(
    sendToRenderer: (channel: string, data: any) => void,
    workerAgent: AgentManager,
    options: { dataDir: string; localModelManager?: LocalModelManager; skillManager?: SkillManager }
  ) {
    this.sendToRenderer = sendToRenderer
    this.workerAgent = workerAgent
    this.skillManager = options.skillManager || null
    this.dataDir = options.dataDir
    this.localModelManager = options.localModelManager || null
  }

  // ---------------------------------------------------------------------------
  // Orchestrator system prompt
  // ---------------------------------------------------------------------------

  private buildOnitSystemPrompt(): string {
    const now = new Date()
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    const dateStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}, ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
    const osName = os.platform() === 'darwin' ? 'macOS' : os.platform() === 'win32' ? 'Windows' : 'Linux'
    const homeDir = os.homedir()

    // Dynamic context from current tasks
    const taskList = Array.from(this.tasks.values())
    let contextBlock = buildContextInjection(taskList)

    // Add scratchpad info if available
    if (this.scratchpadDir) {
      contextBlock += `\n### Scratchpad\nShared directory for cross-worker knowledge: \`${this.scratchpadDir}\`\nWorkers can read/write here. Use this when one worker's research output is needed by another worker.\n`
    }

    return `You are Onit, the user's personal intelligent assistant running on their desktop. You coordinate worker agents to accomplish tasks on the user's behalf.

**LANGUAGE RULE: Always respond in the same language the user writes in. If the user writes in Chinese, respond in Chinese. If in English, respond in English.**

Current: ${dateStr} | ${osName} | Home: ${homeDir}

## Your Role
You are a **coordinator**, not an executor. You cannot read files, edit code, or run commands directly — workers do that. Your job is to:
1. Understand user intent and break down complex requests
2. Dispatch well-crafted prompts to workers
3. Synthesize worker results into clear answers
4. Make smart routing decisions (reuse vs. new session)

Answer questions directly when possible — don't dispatch work you can handle without tools (greetings, knowledge, web search).

## Core Principle: Never Delegate Understanding

When a worker returns results, you MUST read and understand them before acting. Never write "based on your findings, fix the bug." Instead:
1. Read the worker's findings
2. Identify the specific approach, file paths, and line numbers
3. Write a follow-up prompt that proves you understood

Bad: "The research worker found some issues. Fix them."
Good: "In src/auth.ts line 42, the validateToken() function doesn't check expiry. Add an expiry check before the return statement on line 58."

## Task Workflow

For complex requests, follow these phases:

### Phase 1: Research (parallel if independent)
Dispatch workers to explore the codebase, gather information, or investigate options. Multiple independent research tasks CAN run in parallel.

### Phase 2: Synthesis (you, not workers)
Read the research results. Understand the approach. Identify specific files, functions, and changes needed. Summarize your understanding to the user if the task is significant.

### Phase 3: Implementation (one at a time per file set)
Dispatch an implementation worker with a specific, self-contained prompt. Include file paths, function names, and exactly what to change. Write tasks DO NOT run in parallel on the same files.

### Phase 4: Verification (separate worker)
For significant changes, dispatch a separate worker to verify (run tests, check for regressions). Use a fresh session — verification workers should have "fresh eyes," not implementation bias.

## Writing Worker Prompts

Workers cannot see your conversation. Every prompt must be **self-contained** with everything the worker needs. Brief the worker like a smart colleague who just walked into the room.

- Include: what to do, which files/functions, expected outcome, constraints
- Bad: "Fix the login bug" (vague, no context)
- Good: "In /Users/xxx/project/src/auth.ts, the login function at line 30 throws 'undefined is not a function' when the token is expired. Read the file, find the issue, and fix it. The token validation logic is in validateToken() around line 42."

## Continue vs. Spawn Decision

| Situation | Decision | Reason |
|-----------|----------|--------|
| Worker researched the files that need editing | **Reuse** (reuse_session_id) | Worker has file context |
| Research was broad but implementation is narrow | **New session** | Avoid exploration noise |
| Correcting a failure from the same worker | **Reuse** | Worker has error context |
| Verifying code another worker wrote | **New session** | Fresh eyes, no bias |
| Completely wrong approach | **New session** | Clean slate |

## When to Dispatch vs. Handle Directly

**Handle directly (no dispatch):**
- Greetings, chitchat → reply
- Simple knowledge → reply
- Quick lookups → web_search
- Follow-up on completed task → get_task_result
- Clarifying user intent → ask_user

**Dispatch to worker:**
- Anything needing file access (read, write, edit, search)
- Code analysis, review, refactoring
- Multi-step operations, script execution
- Long research across multiple files/sources

## Tools
- **dispatch_task**: Send work to a worker. Workers have file, command, search, and browser tools.
- **list_tasks**: Check all tasks and reusable sessions. Call this BEFORE dispatching to check for reuse.
- **get_task_result**: Retrieve completed task results. Read and synthesize before responding to user.
- **check_task_status / cancel_task**: Monitor or stop running tasks.
- **search_tasks**: Find past tasks by keyword.
- **web_search**: Quick web search. No dispatch needed for simple lookups.
- **ask_user**: Ask structured questions when you need user input to make a decision.

## Session Management

### Session reuse (check EVERY TIME before dispatch)
ALWAYS call list_tasks or check the "Existing Sessions" in Current Context BEFORE dispatching. If the user's request relates to an existing session, reuse it via reuse_session_id.

### topic (REQUIRED)
Always set topic. Use lowercase English, hyphen-separated. Be specific and consistent:
- "code-review", "research-ai", "data-analysis", "bug-fix-auth"
- Reuse the SAME topic name for the same subject

### task_type
- **persistent** (default): context preserved — code review, research, project work
- **temporary**: no useful history — weather, translation, quick lookup

## UX Rules
1. **Acknowledge first**: ALWAYS say something brief before calling tools. "好的，我来处理。" Never start with a silent tool call.
2. **Synthesize results**: When a task completes, read the result via get_task_result and tell the user the key findings in your own words. Don't just say "done."
3. **Don't over-dispatch**: Simple questions don't need workers. Use your knowledge or web_search.
4. **Don't fabricate**: If unsure, search or admit uncertainty.
5. **Parallel research, serial writes**: Multiple read-only research tasks can run simultaneously. Write-heavy tasks should be sequential to avoid file conflicts.
${contextBlock}`
  }

  // ---------------------------------------------------------------------------
  // Orchestrator AgentManager setup
  // ---------------------------------------------------------------------------

  private ensureOrchestrator(): AgentManager {
    if (this.orchestratorAgent) return this.orchestratorAgent

    // Create a dedicated AgentManager for the orchestrator with copilot tools
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this

    this.orchestratorAgent = new AgentManager(
      // Forward orchestrator streaming events with copilot:* channels
      (channel: string, data: any) => {
        const copilotChannel = channel.replace(/^agent:/, 'copilot:')
        // Capture orchestrator's SessionMemory so it survives across rebuilds
        if (channel === 'agent:memory-update' && data.memory) {
          this.orchestratorSessionMemory = {
            content: data.memory.content,
            updatedAt: data.memory.updatedAt || Date.now(),
            version: data.memory.version,
          }
        }
        this.sendToRenderer(copilotChannel, data)
      },
      {
        localModelManager: this.localModelManager || undefined,
        // Custom tools: copilot orchestration tools instead of file tools
        toolsOverride: COPILOT_TOOLS,
        // Custom tool executor that delegates to executeCopilotTool
        toolExecutorOverride: async (
          toolName: string,
          argsStr: string,
          workspacePath: string | null,
          opts: { signal?: AbortSignal }
        ) => {
          return executeCopilotTool(toolName, argsStr, workspacePath, {
            signal: opts.signal,
            copilotManager: self,
          })
        },
        // Prepend Onit system prompt
        systemPromptPrepend: this.buildOnitSystemPrompt(),
      },
    )

    return this.orchestratorAgent
  }

  // ---------------------------------------------------------------------------
  // Main Agent lifecycle
  // ---------------------------------------------------------------------------

  async startMainAgent(userMessage: string, runId: string, apiConfig: any, conversationHistory?: any[]): Promise<boolean> {
    this.apiConfig = apiConfig
    this.currentRunId = runId

    // Ensure scratchpad directory exists for cross-worker knowledge sharing
    this.ensureScratchpad()

    // Rebuild orchestrator to refresh dynamic context (task list changes between calls)
    this.orchestratorAgent = null
    const orchestrator = this.ensureOrchestrator()

    const sessionId = 'copilot-main'

    return orchestrator.startAgent(sessionId, userMessage, runId, {
      apiConfig,
      permissionMode: 'full-access',
      workspacePath: null,
      messages: conversationHistory || [],
      sessionMemory: this.orchestratorSessionMemory,
    })
  }

  stopMainAgent(): void {
    if (this.orchestratorAgent) {
      this.orchestratorAgent.stopAgent('copilot-main')
    }
    // Flush buffered chunks and clear timers
    this.flushAllTaskChunks()
  }

  private ensureScratchpad(): void {
    if (this.scratchpadDir) return
    try {
      this.scratchpadDir = path.join(this.dataDir, 'scratchpad')
      fs.mkdirSync(this.scratchpadDir, { recursive: true })
    } catch {
      this.scratchpadDir = null
    }
  }

  private listTasksSorted(): CopilotTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt)
  }

  private findLatestTaskBySessionId(sessionId: string): CopilotTask | null {
    return this.listTasksSorted().find(task => task.sessionId === sessionId) || null
  }

  private findTaskForRun(sessionId: string, runId: string): CopilotTask | null {
    return this.listTasksSorted().find(
      task => task.sessionId === sessionId && task.lastRunId === runId,
    ) || null
  }

  private emitTaskEvent(type: string, task: CopilotTask): void {
    this.sendToRenderer('copilot:task-event', {
      type,
      task: { ...task },
    })
  }

  private persistTask(task: CopilotTask, eventType?: string): void {
    this.tasks.set(task.id, task)
    saveTask(this.dataDir, task)
    if (eventType) {
      this.emitTaskEvent(eventType, task)
    }
  }

  private flushTaskChunks(taskId: string): void {
    const pending = this.pendingTaskChunks.get(taskId)
    if (!pending) return
    const timer = this.pendingTaskChunkTimers.get(taskId)
    if (timer) {
      clearTimeout(timer)
    }

    const task = this.tasks.get(taskId)
    if (!task || !task.messages) {
      this.pendingTaskChunks.delete(taskId)
      this.pendingTaskChunkTimers.delete(taskId)
      return
    }

    task.messages = applyTaskStreamChunks(task.messages, pending.runId, pending.chunks)
    this.pendingTaskChunks.delete(taskId)
    this.pendingTaskChunkTimers.delete(taskId)
    this.persistTask(task, 'updated')
  }

  private queueTaskChunk(task: CopilotTask, runId: string, chunk: StreamChunk): void {
    const pending = this.pendingTaskChunks.get(task.id)
    if (pending) {
      pending.chunks.push(chunk)
    } else {
      this.pendingTaskChunks.set(task.id, { runId, chunks: [chunk] })
    }

    if (this.pendingTaskChunkTimers.has(task.id)) return

    const timer = setTimeout(() => {
      this.flushTaskChunks(task.id)
    }, TASK_CHUNK_FLUSH_MS)
    this.pendingTaskChunkTimers.set(task.id, timer)
  }

  private flushAllTaskChunks(): void {
    for (const taskId of Array.from(this.pendingTaskChunks.keys())) {
      this.flushTaskChunks(taskId)
    }
  }

  /** Find the most recent persistent task with a matching topic (fuzzy match). */
  private findSessionByTopic(topic: string): CopilotTask | null {
    const normalized = normalizeTopic(topic)
    let best: CopilotTask | null = null
    for (const t of this.tasks.values()) {
      if (t.taskType !== 'persistent' || !t.topic) continue
      const nt = normalizeTopic(t.topic)
      // Exact match (after normalization) OR containment
      const matches = nt === normalized || nt.includes(normalized) || normalized.includes(nt)
      if (matches && (!best || t.createdAt > best.createdAt)) {
        best = t
      }
    }
    return best
  }

  private getReusableSessionState(sessionId?: string): { messages: Message[]; sessionMemory: SessionMemory | null } {
    if (!sessionId) {
      return { messages: [], sessionMemory: null }
    }

    const latestTask = this.findLatestTaskBySessionId(sessionId)
    return {
      messages: latestTask?.messages ? [...latestTask.messages] : [],
      sessionMemory: latestTask?.sessionMemory || null,
    }
  }

  private summarizeTask(task: CopilotTask): CopilotTask {
    const extracted = extractTaskResult(task.messages || [])

    if (extracted.finalResponse) {
      task.finalResponse = extracted.finalResponse
    }

    if (extracted.summary) {
      task.summary = extracted.summary
    } else if (!task.summary) {
      task.summary = task.status === 'completed'
        ? 'Task completed successfully'
        : task.status === 'cancelled'
          ? 'Cancelled by user'
          : `Task ended with status: ${task.status}`
    }

    return task
  }

  private buildTaskResultMessage(task: CopilotTask): string {
    const resultBody = task.finalResponse || task.summary || ''
    const conciseResult = resultBody.length > 800
      ? task.summary || `${resultBody.slice(0, 800).trim()}...`
      : resultBody

    const label = task.name || task.description.substring(0, 50)

    if (task.status === 'completed') {
      return conciseResult
        ? `✅ **${label}**\n\n${conciseResult}`
        : `✅ **${label}** — done.`
    }

    if (task.status === 'cancelled') {
      return `⏹️ **${label}** — cancelled.`
    }

    return conciseResult
      ? `❌ **${label}**\n\n${conciseResult}`
      : `❌ **${label}** — failed.`
  }

  private normalizeLoadedTask(task: CopilotTask): CopilotTask | null {
    const now = Date.now()
    const age = now - (task.completedAt || task.createdAt)

    // Usage-based retention: more used = longer retention
    const baseRetention = task.taskType === 'temporary' ? 3 * DAY_MS : 7 * DAY_MS
    const accessBonus = (task.accessCount || 0) * 2 * DAY_MS
    const lastAccess = task.lastAccessedAt || task.completedAt || task.createdAt
    const recencyBonus = (now - lastAccess) < 3 * DAY_MS ? 7 * DAY_MS : 0
    const retention = Math.min(baseRetention + accessBonus + recencyBonus, MAX_RETENTION_MS)

    if (age > retention && task.status !== 'running' && task.status !== 'queued') {
      deleteTaskFile(this.dataDir, task.id)
      return null
    }

    if (task.status === 'running' || task.status === 'queued') {
      task.status = 'failed'
      task.completedAt = now
      if (!task.summary) {
        task.summary = 'Task stopped because the app was restarted.'
      }
      task.messages = completeTaskRun(task.messages || [], task.lastRunId || '')
      this.summarizeTask(task)
      saveTask(this.dataDir, task)
    }

    return task
  }

  onWorkerStream(sessionId: string, runId: string, chunk: StreamChunk): void {
    const task = this.findTaskForRun(sessionId, runId)
    if (!task || !task.messages) return
    this.queueTaskChunk(task, runId, chunk)

    // Extract real-time progress from tool-call-start events
    if (chunk.type === 'tool-call-start' && chunk.toolCall) {
      const hint = this.extractProgressHint(chunk.toolCall.name, chunk.toolCall.arguments)
      if (hint) {
        this.sendToRenderer('copilot:task-event', {
          type: 'progress',
          taskId: task.id,
          task: { ...task, summary: hint },
        })
      }
    }
  }

  /**
   * Extract a short, human-readable progress hint from a tool call.
   * Zero LLM cost — pure string extraction.
   */
  private extractProgressHint(toolName: string, argsStr: string): string | null {
    try {
      const args = JSON.parse(argsStr || '{}')
      switch (toolName) {
        case 'read_file': return `Reading ${this.shortenPath(args.path)}`
        case 'write_file': return `Writing ${this.shortenPath(args.path)}`
        case 'edit_file': return `Editing ${this.shortenPath(args.path)}`
        case 'delete_file': return `Deleting ${this.shortenPath(args.path)}`
        case 'search_files': return `Searching files: ${args.pattern || ''}`
        case 'search_content': return `Searching: ${(args.query || '').substring(0, 40)}`
        case 'list_directory': return `Listing ${this.shortenPath(args.path)}`
        case 'execute_command': return `Running: ${(args.command || '').substring(0, 50)}`
        case 'web_search': return `Searching: ${(args.query || '').substring(0, 40)}`
        case 'web_fetch': return `Fetching ${this.shortenPath(args.url)}`
        case 'browser_navigate': return `Opening ${this.shortenPath(args.url)}`
        case 'browser_action': return `Browser: ${args.action || ''}`
        case 'create_task_list': return 'Updating task list'
        default: return `Using ${toolName}`
      }
    } catch {
      return null
    }
  }

  private shortenPath(p: string | undefined): string {
    if (!p) return ''
    // Show last 2 path segments for readability
    const parts = p.replace(/\\/g, '/').split('/')
    return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p
  }

  onWorkerMemoryUpdate(sessionId: string, runId: string, memory: SessionMemory | null): void {
    const task = this.findTaskForRun(sessionId, runId)
    if (!task) return

    task.sessionMemory = memory
    this.persistTask(task, 'updated')
  }

  onWorkerError(sessionId: string, runId: string, error: string): void {
    const task = this.findTaskForRun(sessionId, runId)
    if (!task || !task.messages) return

    this.flushTaskChunks(task.id)
    task.messages = applyTaskError(task.messages, runId, error, Date.now())
    this.persistTask(task, 'updated')
  }

  // ---------------------------------------------------------------------------
  // Task dispatch (called by copilot tools via executeCopilotTool)
  // ---------------------------------------------------------------------------

  async dispatchTask(args: {
    description: string
    topic?: string
    reuse_session_id?: string
    task_type?: string
    workspace?: string
    skills?: string[]
  }): Promise<CopilotTask> {
    const taskId = uuidv4().replace(/-/g, '').substring(0, 12)

    // Topic: LLM should always provide one. Fallback: extract from description.
    const topic = args.topic || generateSimpleTopic(args.description)

    // Task type: LLM decides. Default to persistent (context preservation is generally valuable).
    const taskType: 'temporary' | 'persistent' =
      args.task_type === 'temporary' ? 'temporary' : 'persistent'
    // Session routing: explicit reuse > auto-match by topic > new session
    let resolvedSessionId = args.reuse_session_id

    // Auto-match: if no explicit reuse but topic matches an existing persistent session
    if (!resolvedSessionId && topic && taskType === 'persistent') {
      const matchingTask = this.findSessionByTopic(topic)
      if (matchingTask) {
        resolvedSessionId = matchingTask.sessionId
        // Track usage on the matched session
        matchingTask.accessCount = (matchingTask.accessCount || 0) + 1
        matchingTask.lastAccessedAt = Date.now()
        saveTask(this.dataDir, matchingTask)
      }
    }

    const shouldForkRunningSession = resolvedSessionId
      ? this.workerAgent.isSessionRunning(resolvedSessionId)
      : false
    const sessionId = resolvedSessionId && !shouldForkRunningSession
      ? resolvedSessionId
      : `copilot-task-${taskId}`
    const reusableState = this.getReusableSessionState(resolvedSessionId)
    const runId = uuidv4()
    const now = Date.now()

    const task: CopilotTask = {
      id: taskId,
      name: args.description.substring(0, 50),
      sessionId,
      description: args.description,
      status: 'queued',
      taskType,
      topic,
      createdAt: now,
      workspace: args.workspace,
      skills: typeof args.skills === 'string' ? (args.skills as string).split(',').map(s => s.trim()) : args.skills,
      messages: buildTaskRunMessages(reusableState.messages, args.description, runId, now),
      sessionMemory: reusableState.sessionMemory,
      lastRunId: runId,
    }

    this.persistTask(task, 'created')

    // Start the worker session
    task.status = 'running'
    this.persistTask(task, 'started')

    try {
      // Get enabled skills so the worker can use them
      const enabledSkills = this.skillManager
        ? this.skillManager.getEnabledSkills().map(s => ({
            name: s.name, displayName: s.displayName,
            description: s.description, content: s.content, memory: s.memory,
          }))
        : []

      // Build message with skill mentions if specified
      let workerMessage = args.description
      if (args.skills && args.skills.length > 0) {
        workerMessage = args.skills.map(s => `@${s}`).join(' ') + ' ' + workerMessage
      }

      // Append scratchpad hint if available so worker knows about shared storage
      if (this.scratchpadDir) {
        workerMessage += `\n\n[Shared scratchpad directory: ${this.scratchpadDir} — you can read/write files here to share knowledge with other workers.]`
      }

      await this.workerAgent.startAgent(sessionId, workerMessage, runId, {
        apiConfig: this.apiConfig,
        permissionMode: 'accept-edit',
        workspacePath: args.workspace || null,
        messages: reusableState.messages,
        sessionMemory: reusableState.sessionMemory,
        enabledSkills,
      })
    } catch (err: any) {
      task.status = 'failed'
      task.completedAt = Date.now()
      task.summary = `Failed to start: ${err.message || String(err)}`
      task.messages = applyTaskError(task.messages || [], runId, err.message || String(err), Date.now())
      this.persistTask(task, 'failed')
    }

    return task
  }

  listTasks(): CopilotTask[] {
    return this.listTasksSorted()
  }

  getTaskResult(taskId: string): { status: string; summary?: string; result?: string; sessionId?: string } {
    const task = this.tasks.get(taskId)
    if (!task) {
      return { status: 'not_found' }
    }
    // Track access
    task.accessCount = (task.accessCount || 0) + 1
    task.lastAccessedAt = Date.now()
    saveTask(this.dataDir, task)

    return {
      status: task.status,
      summary: task.summary,
      result: task.finalResponse,
      sessionId: task.sessionId,
    }
  }

  /** Keyword search across task names, descriptions, topics, summaries. */
  searchTasks(query: string, limit: number = 5): CopilotTask[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0)
    if (keywords.length === 0) return this.listTasksSorted().slice(0, limit)

    return this.listTasksSorted()
      .filter(task => {
        const searchable = [
          task.name, task.description, task.topic,
          task.summary, task.finalResponse?.substring(0, 500),
        ].filter(Boolean).join(' ').toLowerCase()
        return keywords.some(kw => searchable.includes(kw))
      })
      .slice(0, limit)
  }

  checkTaskStatus(taskId: string): { status: string; progress?: string } {
    const task = this.tasks.get(taskId)
    if (!task) {
      return { status: 'not_found' }
    }
    if (task.status === 'running') {
      const elapsed = Math.round((Date.now() - task.createdAt) / 1000)
      return {
        status: task.status,
        progress: `Running for ${elapsed}s`,
      }
    }
    return {
      status: task.status,
      progress: task.summary,
    }
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task) return false
    if (task.status !== 'running' && task.status !== 'queued') return false

    // Stop the worker session
    this.workerAgent.stopAgent(task.sessionId)

    task.status = 'cancelled'
    task.completedAt = Date.now()
    task.summary = 'Cancelled by user'
    task.messages = completeTaskRun(task.messages || [], task.lastRunId || '')
    this.persistTask(task, 'cancelled')

    return true
  }

  // ---------------------------------------------------------------------------
  // Worker completion callback
  // ---------------------------------------------------------------------------

  onWorkerComplete(sessionId: string, status: string): void {
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionId && task.status === 'running') {
        this.flushTaskChunks(task.id)

        task.status = status === 'completed' ? 'completed' : 'failed'
        task.completedAt = Date.now()
        task.messages = completeTaskRun(task.messages || [], task.lastRunId || '')
        this.summarizeTask(task)
        this.persistTask(task, task.status === 'completed' ? 'completed' : 'failed')

        // Trigger main Agent to auto-report the result with streaming
        if (this.apiConfig && task.status === 'completed') {
          const reportRunId = `copilot-report-${task.id}-${Date.now()}`
          this.sendToRenderer('copilot:auto-report', {
            runId: reportRunId,
            taskId: task.id,
            taskName: task.name,
            message: `[System: Task "${task.name}" (ID: ${task.id}) has completed. Call get_task_result("${task.id}") to retrieve the full result, then tell the user the key findings in your own words. Be concise but include important details.]`,
          })
        } else {
          // Failed tasks: inject static message
          this.sendToRenderer('copilot:task-result', {
            runId: `copilot-report-${task.id}`,
            taskId: task.id,
            content: this.buildTaskResultMessage(task),
            status: task.status,
          })
        }
        break
      }
    }
  }

  // ---------------------------------------------------------------------------
  // API config
  // ---------------------------------------------------------------------------

  setApiConfig(config: any): void {
    this.apiConfig = config
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  async loadData(): Promise<{ messages: any[]; tasks: CopilotTask[] }> {
    const conversation = loadMainConversation(this.dataDir)
    if (conversation.normalized) {
      saveMainConversation(this.dataDir, conversation.messages, conversation.sessionMemory)
    }
    // Restore orchestrator's SessionMemory from disk
    if (conversation.sessionMemory) {
      this.orchestratorSessionMemory = conversation.sessionMemory
    }
    const tasks = loadTasks(this.dataDir)
      .map(task => this.normalizeLoadedTask(task))
      .filter((task): task is CopilotTask => task !== null)

    // Populate in-memory task map
    this.tasks.clear()
    for (const task of tasks) {
      this.tasks.set(task.id, task)
    }

    return {
      messages: conversation.messages,
      tasks,
    }
  }

  async saveData(messages: any[], _tasks: CopilotTask[]): Promise<void> {
    this.flushAllTaskChunks()
    saveMainConversation(this.dataDir, messages, this.orchestratorSessionMemory)

    // Tasks are owned and persisted by the main process to avoid transcript races.
    for (const task of this.tasks.values()) {
      saveTask(this.dataDir, task)
    }
  }
}
