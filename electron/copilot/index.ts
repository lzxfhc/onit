import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import { AgentManager } from '../agent/index'
import type { SkillManager } from '../agent/skills'
import type { LocalModelManager } from '../local-model/index'
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

export type { CopilotTask } from './memory'

export class CopilotManager {
  private sendToRenderer: (channel: string, data: any) => void
  private workerAgent: AgentManager
  private skillManager: SkillManager | null
  private dataDir: string
  private localModelManager: LocalModelManager | null

  /** The orchestrator's own AgentManager (uses copilot tools + Jarvis prompt). */
  private orchestratorAgent: AgentManager | null = null

  /** In-memory task registry. Loaded from disk on startup, saved on changes. */
  private tasks: Map<string, CopilotTask> = new Map()

  /** Current API config for the orchestrator. */
  private apiConfig: any = {}

  /** The orchestrator's current run ID, so we can detect completion. */
  private currentRunId: string | null = null

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

  private buildJarvisSystemPrompt(): string {
    const now = new Date()
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    const dateStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}, ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
    const osName = os.platform() === 'darwin' ? 'macOS' : os.platform() === 'win32' ? 'Windows' : 'Linux'
    const homeDir = os.homedir()

    // Dynamic context from current tasks
    const taskList = Array.from(this.tasks.values())
    const contextBlock = buildContextInjection(taskList)

    return `You are Jarvis, the user's personal intelligent assistant running on their desktop via Onit.
Your job is to help the user accomplish tasks, manage their workflow, and provide a seamless experience.

Current date and time: ${dateStr}
Operating system: ${osName}
Home directory: ${homeDir}

## Your Personality
- Professional yet approachable: not stiff, not overly enthusiastic
- Concise and efficient: convey maximum information with minimum words
- Proactive but respectful: offer suggestions, but let the user decide
- Good memory: remember the user's preferences and ongoing work

## Your Responsibilities
- Understand the user's intent and decide whether to answer directly or dispatch a task
- Manage the user's task queue and schedule work appropriately
- Report results promptly when tasks complete
- Retrieve relevant information from task history when the user asks follow-up questions

## Decision Flow
For each user message, follow this logic:
1. Is it casual chat or a greeting? -> Reply directly
2. Is it a simple factual question? -> Answer directly (or use web_search for quick lookups)
3. Is it a follow-up about a previous task? -> Use list_tasks / get_task_result to find context
4. Does it require tool capabilities (files, commands, multi-step work)? -> Use dispatch_task
5. None of the above -> Treat as general conversation

## Your Tools
- dispatch_task: Create a worker task for complex operations (file work, code analysis, etc.)
- list_tasks: Check active and recent tasks
- get_task_result: Get results of completed tasks
- check_task_status: Check progress of running tasks
- cancel_task: Cancel a running task
- web_search: Quick web search for simple queries (avoid dispatching tasks for simple lookups)

## Important Rules
- CRITICAL: You MUST output a brief text acknowledgment to the user BEFORE calling any tool. For example, output "好的，我来帮你查一下。" FIRST, then in the SAME turn call dispatch_task or web_search. The user must see your acknowledgment immediately, not a silent tool call. This is the most important UX rule.
- NEVER directly operate on the user's file system. Delegate to worker tasks via dispatch_task.
- Do NOT fabricate information. If you don't know something, say so or search for it.
- Do NOT automatically execute dangerous operations without the user's request.
- When multiple tasks are requested, acknowledge them all, then dispatch them.
- Keep the user informed about task progress without being verbose.
- Respond in the same language the user uses.
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
        // Prepend Jarvis system prompt
        systemPromptPrepend: this.buildJarvisSystemPrompt(),
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
  }

  // ---------------------------------------------------------------------------
  // Task dispatch (called by copilot tools via executeCopilotTool)
  // ---------------------------------------------------------------------------

  async dispatchTask(args: {
    description: string
    session_hint?: string
    workspace?: string
    skills?: string[]
    priority?: string
  }): Promise<CopilotTask> {
    const taskId = uuidv4().replace(/-/g, '').substring(0, 12)
    const sessionId = `copilot-task-${args.session_hint || taskId}`

    const task: CopilotTask = {
      id: taskId,
      name: args.description.substring(0, 50),
      sessionId,
      description: args.description,
      status: 'queued',
      createdAt: Date.now(),
      workspace: args.workspace,
      skills: args.skills,
      priority: (args.priority === 'urgent' ? 'urgent' : 'normal') as 'normal' | 'urgent',
    }

    this.tasks.set(taskId, task)
    saveTask(this.dataDir, task)

    // Notify renderer about task creation
    this.sendToRenderer('copilot:task-event', {
      type: 'created',
      task: { ...task },
    })

    // Start the worker session
    task.status = 'running'
    saveTask(this.dataDir, task)

    this.sendToRenderer('copilot:task-event', {
      type: 'started',
      task: { ...task },
    })

    const runId = uuidv4()

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
        messages: [],
        enabledSkills,
      })
    } catch (err: any) {
      task.status = 'failed'
      task.completedAt = Date.now()
      task.summary = `Failed to start: ${err.message || String(err)}`
      saveTask(this.dataDir, task)

      this.sendToRenderer('copilot:task-event', {
        type: 'failed',
        task: { ...task },
      })
    }

    return task
  }

  listTasks(): CopilotTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt)
  }

  getTaskResult(taskId: string): { status: string; summary?: string } {
    const task = this.tasks.get(taskId)
    if (!task) {
      return { status: 'not_found' }
    }
    return {
      status: task.status,
      summary: task.summary,
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
    saveTask(this.dataDir, task)

    this.sendToRenderer('copilot:task-event', {
      type: 'cancelled',
      task: { ...task },
    })

    return true
  }

  // ---------------------------------------------------------------------------
  // Worker completion callback
  // ---------------------------------------------------------------------------

  onWorkerComplete(sessionId: string, status: string): void {
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionId && task.status === 'running') {
        task.status = status === 'completed' ? 'completed' : 'failed'
        task.completedAt = Date.now()
        if (!task.summary) {
          task.summary = status === 'completed'
            ? 'Task completed successfully'
            : `Task ended with status: ${status}`
        }
        saveTask(this.dataDir, task)

        this.sendToRenderer('copilot:task-event', {
          type: task.status === 'completed' ? 'completed' : 'failed',
          task: { ...task },
        })

        // Auto-trigger the orchestrator to report the result to the user
        if (this.apiConfig && status === 'completed') {
          const reportRunId = `copilot-report-${task.id}`
          const reportMessage = `[System notification: Task "${task.name}" has completed. Use get_task_result to retrieve the result and report it to the user.]`
          this.startMainAgent(reportMessage, reportRunId, this.apiConfig).catch(() => {})
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
    const tasks = loadTasks(this.dataDir)

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

  async saveData(messages: any[], tasks: CopilotTask[]): Promise<void> {
    saveMainConversation(this.dataDir, messages)

    // Sync task files
    for (const task of tasks) {
      this.tasks.set(task.id, task)
      saveTask(this.dataDir, task)
    }
  }
}
