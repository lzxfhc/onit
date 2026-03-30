import os from 'os'
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
// Topic inference — auto-generates a topic from task description
// ---------------------------------------------------------------------------

/** Topic keyword map — used ONLY for naming, not for type classification. */
const TOPIC_KEYWORDS: [RegExp, string][] = [
  [/天气|weather|气温|forecast/i, 'weather'],
  [/代码|code|审查|review|bug|debug|fix|refactor/i, 'code-review'],
  [/调研|research|论文|paper|article/i, 'research'],
  [/数据|data|分析|analysis|excel|csv|统计/i, 'data-analysis'],
  [/项目|project|开发|develop|架构/i, 'project'],
  [/文件|file|整理|organize|归档|folder|目录/i, 'file-management'],
  [/文档|document|总结|summary|pdf|报告/i, 'document'],
  [/翻译|translate|translation/i, 'translation'],
  [/搜索|search|查找|look up/i, 'search'],
  [/安装|install|配置|config|setup|环境/i, 'setup'],
  [/git|部署|deploy|发布|release/i, 'devops'],
  [/写|write|创建|create|生成|generate|脚本/i, 'content-creation'],
]

/** Auto-cleanup: sessions not reused within this period are deleted. */
const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

/**
 * Infer a topic name from description. Used for session grouping/matching.
 * Does NOT determine persistent vs temporary — everything defaults to persistent.
 */
function inferTopicName(description: string): string {
  for (const [pattern, topic] of TOPIC_KEYWORDS) {
    if (pattern.test(description)) return topic
  }
  const words = description.replace(/[^\w\u4e00-\u9fff]+/g, ' ').trim().split(/\s+/).slice(0, 3)
  return words.join('-').toLowerCase().substring(0, 30) || 'general'
}

const TASK_CHUNK_FLUSH_MS = 80
const COMPLETED_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export class CopilotManager {
  private sendToRenderer: (channel: string, data: any) => void
  private workerAgent: AgentManager
  private skillManager: SkillManager | null
  private dataDir: string
  private localModelManager: LocalModelManager | null

  /** The orchestrator's own AgentManager (uses copilot tools + Onit prompt). */
  private orchestratorAgent: AgentManager | null = null

  /** In-memory task registry. Loaded from disk on startup, saved on changes. */
  private tasks: Map<string, CopilotTask> = new Map()

  /** Current API config for the orchestrator. */
  private apiConfig: any = {}

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
    const contextBlock = buildContextInjection(taskList)

    return `You are Onit, the user's personal intelligent assistant. You run on the user's desktop and manage tasks on their behalf.

**LANGUAGE RULE: Always respond in the same language the user writes in. If the user writes in Chinese, respond in Chinese. If in English, respond in English.**

Current: ${dateStr} | ${osName} | Home: ${homeDir}

## Personality
Concise, professional, approachable. Maximum info in minimum words. Proactive suggestions but respect user decisions.

## How to Handle User Messages

**Direct reply (no tools needed):**
- Greetings, chitchat → reply directly
- Simple knowledge questions → reply directly
- Quick factual lookups (weather, time, simple search) → use web_search directly
- Follow-up about a completed task → use get_task_result to retrieve the answer

**Dispatch to worker (needs file/command/multi-step work):**
- Code analysis, file operations, project work → dispatch_task
- Long research with multiple sources → dispatch_task
- Anything requiring read_file, write_file, execute_command → dispatch_task
- You CANNOT access the file system directly. Worker sessions have file/command tools; you don't.

Examples:
- "查一下北京天气" → web_search (quick, no dispatch needed)
- "帮我审查 src/ 的代码" → dispatch_task (needs file access)
- "你好" → direct reply
- "上次审查结果怎么样" → get_task_result

## Tools
- **web_search**: Quick search. Use for weather, facts, news. No dispatch needed.
- **dispatch_task**: Send work to a worker session that has file/command tools. Set topic and task_type.
- **list_tasks**: See all tasks and reusable sessions.
- **get_task_result**: Get completed task results. Use when user asks about previous work.
- **check_task_status / cancel_task**: Monitor or stop running tasks.

## Session Management

### When to reuse a session (IMPORTANT)
ALWAYS check the "Existing Sessions" list in Current Context below BEFORE creating a new session.
If the user's request is related to ANY existing session's topic, you MUST reuse that session.
- Same topic → set reuse_session_id to that session's ID
- Related topic (e.g., user asks about "上海天气" and there's a "weather" session) → reuse
- Completely new topic → create new session

### task_type
- Don't set task_type in most cases — everything defaults to **persistent**, which is correct.
- Sessions auto-expire after 7 days if not reused, so there's no clutter problem.
- Only set task_type="temporary" for trivially simple tasks like unit conversions or time lookups that definitely won't need context later.

### topic naming rules
- Use lowercase English, hyphen-separated: "code-review", "weather", "data-analysis"
- Be specific enough to distinguish: "research-ai" not just "research"
- Be consistent: don't create "weather" and "天气" as separate topics
- ALWAYS set a topic for persistent tasks

## Critical UX Rules
1. **Acknowledge first**: ALWAYS output a brief text response BEFORE calling any tool. Example: "好的，我来查一下。" then call web_search. Never start with a silent tool call.
2. **Task results in conversation**: When a task completes, its result will appear in the conversation as a ✅ message. You don't need to re-fetch or re-explain unless the user asks for more details.
3. **Don't over-dispatch**: Simple questions don't need dispatch_task. Use web_search or your own knowledge when possible.
4. **Don't fabricate**: If unsure, search or say you don't know.
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
        // Map agent:stream -> copilot:stream, agent:complete -> copilot:complete, etc.
        const copilotChannel = channel.replace(/^agent:/, 'copilot:')
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

    // Rebuild orchestrator to refresh dynamic context (task list changes between calls)
    this.orchestratorAgent = null
    const orchestrator = this.ensureOrchestrator()

    const sessionId = 'copilot-main'

    return orchestrator.startAgent(sessionId, userMessage, runId, {
      apiConfig,
      permissionMode: 'full-access',
      workspacePath: null,
      messages: conversationHistory || [],
    })
  }

  stopMainAgent(): void {
    if (this.orchestratorAgent) {
      this.orchestratorAgent.stopAgent('copilot-main')
    }
    // Flush buffered chunks and clear timers
    this.flushAllTaskChunks()
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

  /** Find the most recent persistent task with a matching topic. */
  private findSessionByTopic(topic: string): CopilotTask | null {
    let best: CopilotTask | null = null
    for (const t of this.tasks.values()) {
      if (t.taskType !== 'persistent') continue
      if (t.topic === topic && (!best || t.createdAt > best.createdAt)) {
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
    const isExpired = age > COMPLETED_TASK_RETENTION_MS

    if (isExpired && task.status !== 'running' && task.status !== 'queued') {
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

    // Topic: LLM explicit > auto-inferred from description
    const topic = args.topic || inferTopicName(args.description)

    // Everything persistent by default. LLM can explicitly mark temporary for
    // trivially simple tasks, but we don't try to guess.
    const taskType: 'temporary' | 'persistent' = args.task_type === 'temporary' ? 'temporary' : 'persistent'
    // Session routing: explicit reuse > auto-match by topic > new session
    let resolvedSessionId = args.reuse_session_id

    // Auto-match: if no explicit reuse but topic matches an existing persistent session
    if (!resolvedSessionId && topic && taskType === 'persistent') {
      const matchingTask = this.findSessionByTopic(topic)
      if (matchingTask) {
        resolvedSessionId = matchingTask.sessionId
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
    return {
      status: task.status,
      summary: task.summary,
      result: task.finalResponse,
      sessionId: task.sessionId,
    }
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

        // Inject task result directly into the copilot conversation
        const reportRunId = `copilot-report-${task.id}`
        this.sendToRenderer('copilot:task-result', {
          runId: reportRunId,
          taskId: task.id,
          content: this.buildTaskResultMessage(task),
          status: task.status,
        })
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
      saveMainConversation(this.dataDir, conversation.messages)
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
    saveMainConversation(this.dataDir, messages)

    // Tasks are owned and persisted by the main process to avoid transcript races.
    for (const task of this.tasks.values()) {
      saveTask(this.dataDir, task)
    }
  }
}
