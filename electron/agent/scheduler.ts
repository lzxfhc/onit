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
}

export class SchedulerManager {
  private dataDir: string
  private agentManager: AgentManager
  private jobs: Map<string, schedule.Job> = new Map()
  private apiConfig: { billingMode: string; apiKey: string; customBaseUrl?: string; codingPlanProvider?: string } | null = null

  constructor(dataDir: string, agentManager: AgentManager) {
    this.dataDir = dataDir
    this.agentManager = agentManager
    this.loadAndScheduleAll()
  }

  setApiConfig(config: { billingMode: string; apiKey: string; customBaseUrl?: string; codingPlanProvider?: string }): void {
    this.apiConfig = config
  }

  private getFilePath(id: string): string {
    return path.join(this.dataDir, `${id}.json`)
  }

  private saveTask(task: ScheduledTaskData): void {
    fs.writeFileSync(this.getFilePath(task.id), JSON.stringify(task, null, 2), 'utf-8')
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
      const content = fs.readFileSync(path.join(this.dataDir, f), 'utf-8')
      return JSON.parse(content)
    }).sort((a, b) => b.createdAt - a.createdAt)
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

  async runTaskNow(id: string, sendToRenderer?: (channel: string, data: any) => void): Promise<boolean> {
    const task = this.loadTask(id)
    if (!task) return false

    if (!this.apiConfig || !this.apiConfig.apiKey) {
      return false
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
        sessionId,
        runId,
        workspacePath: task.workspacePath,
        model: task.model,
      })
    }

    await this.agentManager.startAgent(sessionId, task.taskPrompt, runId, {
      permissionMode: 'full-access',
      workspacePath: task.workspacePath,
      model: task.model,
      messages: [],
      apiConfig: this.apiConfig,
    })

    return true
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
    const hour = parseInt(hourStr, 10) || 9
    const minute = parseInt(minuteStr, 10) || 0

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
      this.runTaskNow(task.id)
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
      this.runTaskNow(task.id)
      // Auto-disable after one-time execution
      task.enabled = false
      task.lastRun = Date.now()
      task.nextRun = null
      this.saveTask(task)
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
