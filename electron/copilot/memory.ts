import fs from 'fs'
import path from 'path'

export interface CopilotTask {
  id: string
  sessionId: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  createdAt: number
  completedAt?: number
  summary?: string
  workspace?: string
  skills?: string[]
  priority?: 'normal' | 'urgent'
}

interface MainConversationData {
  messages: any[]
  lastSaved: number
}

/**
 * Load the main copilot conversation from disk.
 */
export function loadMainConversation(dataDir: string): MainConversationData {
  const filePath = path.join(dataDir, 'copilot', 'main.json')
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      return {
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        lastSaved: typeof parsed.lastSaved === 'number' ? parsed.lastSaved : 0,
      }
    }
  } catch {
    // Corrupted file — start fresh
  }
  return { messages: [], lastSaved: 0 }
}

/**
 * Save the main copilot conversation to disk (atomic: write tmp then rename).
 */
export function saveMainConversation(dataDir: string, messages: any[]): void {
  const dir = path.join(dataDir, 'copilot')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const filePath = path.join(dir, 'main.json')
  const tmpPath = filePath + '.tmp'
  const data: MainConversationData = {
    messages,
    lastSaved: Date.now(),
  }
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

/**
 * Load all tasks from copilot/tasks/*.json.
 */
export function loadTasks(dataDir: string): CopilotTask[] {
  const tasksDir = path.join(dataDir, 'copilot', 'tasks')
  if (!fs.existsSync(tasksDir)) return []

  const files = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'))
  const tasks: CopilotTask[] = []

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(tasksDir, file), 'utf-8')
      const task = JSON.parse(raw) as CopilotTask
      if (task && task.id) {
        tasks.push(task)
      }
    } catch {
      // Skip corrupted files
    }
  }

  return tasks.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Save a single task to copilot/tasks/{id}.json (atomic).
 */
export function saveTask(dataDir: string, task: CopilotTask): void {
  const tasksDir = path.join(dataDir, 'copilot', 'tasks')
  if (!fs.existsSync(tasksDir)) {
    fs.mkdirSync(tasksDir, { recursive: true })
  }
  const filePath = path.join(tasksDir, `${task.id}.json`)
  const tmpPath = filePath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(task, null, 2), 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

/**
 * Delete a task file.
 */
export function deleteTask(dataDir: string, taskId: string): void {
  // Validate ID to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) return
  const filePath = path.join(dataDir, 'copilot', 'tasks', `${taskId}.json`)
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

/**
 * Build a dynamic context injection block for the orchestrator's system prompt.
 * Lists active tasks, recent completions, etc. Max 10 tasks, summaries under 200 chars.
 */
export function buildContextInjection(tasks: CopilotTask[]): string {
  if (tasks.length === 0) {
    return '\n## Current Context\n\nNo active or recent tasks.\n'
  }

  // Take at most 10 tasks
  const relevantTasks = tasks.slice(0, 10)

  const activeTasks = relevantTasks.filter(t => t.status === 'running' || t.status === 'pending')
  const completedTasks = relevantTasks.filter(t => t.status === 'completed')
  const failedTasks = relevantTasks.filter(t => t.status === 'failed' || t.status === 'cancelled')

  const lines: string[] = ['\n## Current Context\n']

  if (activeTasks.length > 0) {
    lines.push('### Active Tasks')
    for (const t of activeTasks) {
      const elapsed = Math.round((Date.now() - t.createdAt) / 60000)
      const desc = t.description.substring(0, 200)
      lines.push(`- [${t.id}] "${desc}" | Status: ${t.status} | Started: ${elapsed}m ago | Session: ${t.sessionId}`)
    }
    lines.push('')
  }

  if (completedTasks.length > 0) {
    lines.push('### Recently Completed')
    for (const t of completedTasks) {
      const desc = t.description.substring(0, 100)
      const summary = t.summary ? t.summary.substring(0, 200) : 'No summary'
      const completedAt = t.completedAt ? new Date(t.completedAt).toLocaleTimeString() : 'unknown'
      lines.push(`- [${t.id}] "${desc}" | Completed: ${completedAt} | Summary: ${summary}`)
    }
    lines.push('')
  }

  if (failedTasks.length > 0) {
    lines.push('### Failed/Cancelled')
    for (const t of failedTasks) {
      const desc = t.description.substring(0, 100)
      lines.push(`- [${t.id}] "${desc}" | Status: ${t.status}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
