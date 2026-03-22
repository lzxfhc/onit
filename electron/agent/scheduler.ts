import fs from 'fs'
import path from 'path'
import schedule from 'node-schedule'
import { v4 as uuidv4 } from 'uuid'
import { AgentManager } from './index'

interface ScheduledTaskData {
  id: string
  name: string
  description: string
  taskPrompt: string
  model: string
  workspacePath: string | null
  frequency: string
  enabled: boolean
  lastRun: number | null
  nextRun: number | null
  createdAt: number
  // v1.1.0: Enhanced scheduling fields
  scheduleTime?: string          // "HH:mm" for daily/weekly/weekdays
  scheduleDayOfWeek?: number     // 0-6 (Sun-Sat) for weekly
  scheduleDayOfMonth?: number    // 1-31 for monthly
  scheduleDateTime?: string      // ISO datetime for once
  permissionMode?: string        // 'plan' | 'accept-edit' | 'full-access'
}

type SchedulerTriggerSource = 'manual' | 'scheduled'

export class SchedulerManager {
  private dataDir: string
  private agentManager: AgentManager
  private jobs: Map<string, schedule.Job> = new Map()
  private rendererEmitter?: (channel: string, data: any) => void
  private apiConfig: {
    billingMode: string
    apiKey: string
    model?: string
    customBaseUrl?: string
    codingPlanProvider?: string
    localModelId?: string
    maxInputTokens?: number
    maxOutputTokens?: number
  } | null = null

  constructor(
    dataDir: string,
    agentManager: AgentManager,
    rendererEmitter?: (channel: string, data: any) => void,
  ) {
    this.dataDir = dataDir
    this.agentManager = agentManager
    this.rendererEmitter = rendererEmitter
    this.loadAndScheduleAll()
  }

  setApiConfig(config: {
    billingMode: string
    apiKey: string
    model?: string
    customBaseUrl?: string
    codingPlanProvider?: string
    localModelId?: string
    maxInputTokens?: number
    maxOutputTokens?: number
  }): void {
    this.apiConfig = config
  }

  private getFilePath(id: string): string {
    return path.join(this.dataDir, `${id}.json`)
  }

  private saveTask(task: ScheduledTaskData): void {
    const filePath = this.getFilePath(task.id)
    const tmpPath = filePath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(task, null, 2), 'utf-8')
    fs.renameSync(tmpPath, filePath)
  }

  private loadTask(id: string): ScheduledTaskData | null {
    const filePath = this.getFilePath(id)
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  }

  listTasks(): ScheduledTaskData[] {
    if (!fs.existsSync(this.dataDir)) return []
    const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.json'))
    return files.map(f => {
      try {
        const content = fs.readFileSync(path.join(this.dataDir, f), 'utf-8')
        return JSON.parse(content)
      } catch { return null }
    }).filter(Boolean).sort((a: any, b: any) => b.createdAt - a.createdAt)
  }

  createTask(taskData: Partial<ScheduledTaskData>): ScheduledTaskData {
    const task: ScheduledTaskData = {
      id: uuidv4(),
      name: taskData.name || 'Untitled Task',
      description: taskData.description || '',
      taskPrompt: taskData.taskPrompt || '',
      model: taskData.model || 'qianfan-code-latest',
      workspacePath: taskData.workspacePath || null,
      frequency: taskData.frequency || 'manual',
      enabled: taskData.enabled ?? true,
      lastRun: null,
      nextRun: null,
      createdAt: Date.now(),
      scheduleTime: taskData.scheduleTime,
      scheduleDayOfWeek: taskData.scheduleDayOfWeek,
      scheduleDayOfMonth: taskData.scheduleDayOfMonth,
      scheduleDateTime: taskData.scheduleDateTime,
      permissionMode: taskData.permissionMode,
    }

    this.saveTask(task)
    if (task.enabled && task.frequency !== 'manual') {
      this.scheduleTask(task)
    }
    return task
  }

  updateTask(taskData: ScheduledTaskData): ScheduledTaskData {
    this.cancelJob(taskData.id)

    this.saveTask(taskData)
    if (taskData.enabled && taskData.frequency !== 'manual') {
      this.scheduleTask(taskData)
    }
    return taskData
  }

  deleteTask(id: string): boolean {
    this.cancelJob(id)
    const filePath = this.getFilePath(id)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
    return true
  }

  toggleTask(id: string, enabled: boolean): ScheduledTaskData | null {
    const task = this.loadTask(id)
    if (!task) return null

    task.enabled = enabled
    this.saveTask(task)

    if (enabled && task.frequency !== 'manual') {
      this.scheduleTask(task)
    } else {
      this.cancelJob(id)
    }

    return task
  }

  async runTaskNow(
    id: string,
    options?: {
      sendToRenderer?: (channel: string, data: any) => void
      triggerSource?: SchedulerTriggerSource
    },
  ): Promise<boolean> {
    const task = this.loadTask(id)
    if (!task) return false

    const sendToRenderer = options?.sendToRenderer || this.rendererEmitter
    const triggerSource = options?.triggerSource || 'manual'

    if (!this.apiConfig) return false

    if (this.apiConfig.billingMode === 'local-model') {
      if (!this.apiConfig.localModelId) return false
    } else {
      if (!this.apiConfig.apiKey) return false
    }

    task.lastRun = Date.now()
    this.saveTask(task)

    const sessionId = `scheduled-${task.id}-${Date.now()}`
    const runId = `${sessionId}-run`

    // Notify renderer about the new scheduled session
    if (sendToRenderer) {
      sendToRenderer('scheduler:session-created', {
        taskId: task.id,
        taskName: task.name,
        taskPrompt: task.taskPrompt,
        sessionId,
        runId,
        workspacePath: task.workspacePath,
        model: task.model,
        permissionMode: task.permissionMode || 'accept-edit',
        triggerSource,
        openInForeground: triggerSource === 'manual',
      })

      // Wait for the renderer to process the session-created event and register
      // the session in the store. Without this delay the agent starts streaming
      // before the session exists in the renderer, causing all stream events to
      // be silently dropped.
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    try {
      await this.agentManager.startAgent(sessionId, task.taskPrompt, runId, {
        permissionMode: task.permissionMode || 'accept-edit',
        workspacePath: task.workspacePath,
        model: task.model || this.apiConfig.model,
        messages: [],
        apiConfig: { ...this.apiConfig, model: task.model || this.apiConfig.model },
      })
      return true
    } catch (err: any) {
      if (sendToRenderer) {
        sendToRenderer('agent:error', {
          sessionId,
          runId,
          error: err?.message || 'Failed to start scheduled task',
        })
      }
      return false
    }
  }

  shutdown(): void {
    for (const [id] of this.jobs) {
      this.cancelJob(id)
    }
    schedule.gracefulShutdown()
  }

  private frequencyToCron(task: ScheduledTaskData): string | null {
    const time = task.scheduleTime || '09:00'
    const [hourStr, minuteStr] = time.split(':')
    const parsedHour = parseInt(hourStr, 10)
    const hour = Number.isNaN(parsedHour) ? 9 : parsedHour
    const parsedMinute = parseInt(minuteStr, 10)
    const minute = Number.isNaN(parsedMinute) ? 0 : parsedMinute

    switch (task.frequency) {
      case 'hourly':
        return `${minute} * * * *`
      case 'daily':
        return `${minute} ${hour} * * *`
      case 'weekly': {
        const dow = task.scheduleDayOfWeek ?? 1
        return `${minute} ${hour} * * ${dow}`
      }
      case 'monthly': {
        const dom = task.scheduleDayOfMonth ?? 1
        return `${minute} ${hour} ${dom} * *`
      }
      case 'weekdays':
        return `${minute} ${hour} * * 1-5`
      default:
        return null
    }
  }

  private scheduleTask(task: ScheduledTaskData): void {
    this.cancelJob(task.id)

    if (task.frequency === 'once') {
      this.scheduleOnce(task)
      return
    }

    const cron = this.frequencyToCron(task)
    if (!cron) return

    const job = schedule.scheduleJob(cron, () => {
      void this.runTaskNow(task.id, { triggerSource: 'scheduled' })
    })

    if (job) {
      this.jobs.set(task.id, job)
      const nextInvocation = job.nextInvocation()
      if (nextInvocation) {
        task.nextRun = nextInvocation.getTime()
        this.saveTask(task)
      }
    }
  }

  private scheduleOnce(task: ScheduledTaskData): void {
    if (!task.scheduleDateTime) return

    const targetDate = new Date(task.scheduleDateTime)
    if (targetDate.getTime() <= Date.now()) {
      // Already past — skip
      return
    }

    const job = schedule.scheduleJob(targetDate, () => {
      const freshTask = this.loadTask(task.id)
      if (!freshTask) return
      void this.runTaskNow(freshTask.id, { triggerSource: 'scheduled' })
      // Auto-disable after one-time execution
      freshTask.enabled = false
      freshTask.lastRun = Date.now()
      freshTask.nextRun = null
      this.saveTask(freshTask)
      this.jobs.delete(task.id)
    })

    if (job) {
      this.jobs.set(task.id, job)
      task.nextRun = targetDate.getTime()
      this.saveTask(task)
    }
  }

  private cancelJob(id: string): void {
    const job = this.jobs.get(id)
    if (job) {
      job.cancel()
      this.jobs.delete(id)
    }
  }

  private loadAndScheduleAll(): void {
    const tasks = this.listTasks()
    for (const task of tasks) {
      if (task.enabled && task.frequency !== 'manual') {
        this.scheduleTask(task)
      }
    }
  }
}
