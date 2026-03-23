import fs from 'fs'
import path from 'path'
import type { Message, SessionMemory } from '../../src/types'

export interface CopilotTask {
  id: string
  name: string
  sessionId: string
  description: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  /** Task lifecycle: temporary tasks are lightweight and retained only for recent follow-ups */
  taskType: 'temporary' | 'persistent'
  /** Topic/category for session grouping and reuse */
  topic?: string
  createdAt: number
  completedAt?: number
  summary?: string
  finalResponse?: string
  workspace?: string
  skills?: string[]
  priority?: 'normal' | 'urgent'
  messages?: Message[]
  sessionMemory?: SessionMemory | null
  lastRunId?: string | null
}

interface MainConversationData {
  messages: any[]
  lastSaved: number
  normalized?: boolean
}

function normalizeMainConversationMessages(messages: any[]): { messages: any[]; normalized: boolean } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], normalized: false }
  }

  let normalized = false
  const nextMessages: any[] = []

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue

    if (message.role === 'assistant' && message.isStreaming) {
      const hasContent = typeof message.content === 'string' && message.content.trim().length > 0
      const hasThinking = typeof message.thinking === 'string' && message.thinking.trim().length > 0
      const hasToolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0

      normalized = true

      // Drop blank in-flight shells left behind by an interrupted run.
      if (!hasContent && !hasThinking && !hasToolCalls) {
        continue
      }

      nextMessages.push({
        ...message,
        isStreaming: false,
      })
      continue
    }

    nextMessages.push(message)
  }

  return { messages: nextMessages, normalized }
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
      const normalized = normalizeMainConversationMessages(
        Array.isArray(parsed.messages) ? parsed.messages : [],
      )
      return {
        messages: normalized.messages,
        lastSaved: typeof parsed.lastSaved === 'number' ? parsed.lastSaved : 0,
        normalized: normalized.normalized,
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

  const relevantTasks = tasks.slice(0, 15)
  const activeTasks = relevantTasks.filter(t => t.status === 'running' || t.status === 'queued')
  const completedTasks = relevantTasks.filter(t => t.status === 'completed')

  // Persistent sessions that can be reused (have topic and are completed or running)
  const reusableSessions = relevantTasks
    .filter(t => t.taskType === 'persistent' && t.topic)
    .reduce((acc, t) => {
      if (!acc.has(t.topic!)) acc.set(t.topic!, t)
      return acc
    }, new Map<string, CopilotTask>())

  const lines: string[] = ['\n## Current Context\n']

  // Show reusable sessions — the agent should route related tasks here
  if (reusableSessions.size > 0) {
    lines.push('### Reusable Sessions (route related tasks here instead of creating new)')
    for (const [topic, t] of reusableSessions) {
      lines.push(`- Topic: "${topic}" | Session: ${t.sessionId} | Status: ${t.status} | Last task: "${t.name}"`)
    }
    lines.push('')
  }

  if (activeTasks.length > 0) {
    lines.push('### Active Tasks')
    for (const t of activeTasks) {
      const elapsed = Math.round((Date.now() - t.createdAt) / 60000)
      lines.push(`- [${t.id}] "${t.name}" | ${t.topic ? `Topic: ${t.topic} | ` : ''}Status: ${t.status} | ${elapsed}m ago | Session: ${t.sessionId}`)
    }
    lines.push('')
  }

  if (completedTasks.length > 0) {
    lines.push('### Recently Completed')
    for (const t of completedTasks.slice(0, 5)) {
      const summary = t.summary ? t.summary.substring(0, 200) : ''
      lines.push(`- [${t.id}] "${t.name}" | ${t.topic ? `Topic: ${t.topic} | ` : ''}${summary}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
