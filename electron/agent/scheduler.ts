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
}

export class SchedulerManager {
  private dataDir: string
  private agentManager: AgentManager
  private jobs: Map<string, schedule.Job> = new Map()

  constructor(dataDir: string, agentManager: AgentManager) {
    this.dataDir = dataDir
    this.agentManager = agentManager
    this.loadAndScheduleAll()
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
    }

    this.saveTask(task)
    if (task.enabled && task.frequency !== 'manual') {
      this.scheduleTask(task)
    }
    return task
  }

  updateTask(taskData: ScheduledTaskData): ScheduledTaskData {
    // Cancel existing job
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

  async runTaskNow(id: string): Promise<boolean> {
    const task = this.loadTask(id)
    if (!task) return false

    task.lastRun = Date.now()
    this.saveTask(task)

    const sessionId = `scheduled-${task.id}-${Date.now()}`

    await this.agentManager.startAgent(sessionId, task.taskPrompt, {
      permissionMode: 'full-access',
      workspacePath: task.workspacePath,
      model: task.model,
      messages: [],
      apiConfig: {
        billingMode: 'coding-plan',
        apiKey: '',
      },
    })

    return true
  }

  shutdown(): void {
    for (const [id] of this.jobs) {
      this.cancelJob(id)
    }
    schedule.gracefulShutdown()
  }

  private frequencyToCron(frequency: string): string | null {
    switch (frequency) {
      case 'hourly': return '0 * * * *'
      case 'daily': return '0 9 * * *'
      case 'weekly': return '0 9 * * 1'
      case 'weekdays': return '0 9 * * 1-5'
      default: return null
    }
  }

  private scheduleTask(task: ScheduledTaskData): void {
    const cron = this.frequencyToCron(task.frequency)
    if (!cron) return

    this.cancelJob(task.id)

    const job = schedule.scheduleJob(cron, () => {
      this.runTaskNow(task.id)
    })

    if (job) {
      this.jobs.set(task.id, job)
      // Update next run time
      const nextInvocation = job.nextInvocation()
      if (nextInvocation) {
        task.nextRun = nextInvocation.getTime()
        this.saveTask(task)
      }
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
