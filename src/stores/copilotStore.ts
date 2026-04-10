import { create } from 'zustand'
import type { Message, StreamChunk, CopilotTask, AppMode, ContentBlock } from '../types'

interface CopilotState {
  // Mode
  appMode: AppMode
  setAppMode: (mode: AppMode) => void

  // Main Agent conversation
  messages: Message[]
  isRunning: boolean
  activeRunId: string | null

  // Tasks
  tasks: CopilotTask[]
  selectedTaskId: string | null
  taskDetailOpen: boolean

  // Actions — conversation
  addMessage: (msg: Message) => void
  startRun: (userMsg: Message, assistantMsg: Message, runId: string) => void
  completeRun: (runId: string, result: 'completed' | 'stopped' | 'error') => void
  applyStreamChunks: (runId: string, chunks: StreamChunk[]) => void

  // Actions — tasks
  addTask: (task: CopilotTask) => void
  updateTask: (taskId: string, updates: Partial<CopilotTask>) => void
  removeTask: (taskId: string) => void
  selectTask: (taskId: string | null) => void
  setTaskDetailOpen: (open: boolean) => void

  // Persistence
  loadCopilotData: () => Promise<void>
  saveCopilotData: () => Promise<void>
  clearMessages: () => void
}

function applyChunkToMessage(message: Message, chunk: StreamChunk): Message {
  if (chunk.type === 'content' && chunk.content) {
    const blocks = message.contentBlocks ? [...message.contentBlocks] : []
    if (blocks.length > 0 && blocks[blocks.length - 1].type === 'text') {
      const previous = blocks[blocks.length - 1]
      blocks[blocks.length - 1] = {
        ...previous,
        content: (previous.content || '') + chunk.content,
      }
    } else {
      blocks.push({ type: 'text', content: chunk.content })
    }

    return {
      ...message,
      content: message.content + chunk.content,
      contentBlocks: blocks,
    }
  }

  if (chunk.type === 'thinking' && chunk.content) {
    return { ...message, thinking: (message.thinking || '') + chunk.content }
  }

  if (chunk.type === 'tool-call-start' && chunk.toolCall) {
    const toolCalls = [...(message.toolCalls || [])]
    const existingIndex = toolCalls.findIndex(tc => tc.id === chunk.toolCall!.id)
    const nextToolCall = {
      id: chunk.toolCall.id || '',
      name: chunk.toolCall.name || '',
      arguments: chunk.toolCall.arguments || '',
      status: chunk.toolCall.status || 'running',
    }
    if (existingIndex >= 0) {
      toolCalls[existingIndex] = { ...toolCalls[existingIndex], ...nextToolCall }
    } else {
      toolCalls.push(nextToolCall)
    }

    const blocks = [...(message.contentBlocks || [])]
    blocks.push({ type: 'tool-call', toolCallId: chunk.toolCall.id })

    return { ...message, toolCalls, contentBlocks: blocks }
  }

  if (chunk.type === 'tool-call-result' && chunk.toolCall) {
    const toolCalls = [...(message.toolCalls || [])]
    const idx = toolCalls.findIndex(tc => tc.id === chunk.toolCall!.id)
    if (idx >= 0) {
      toolCalls[idx] = { ...toolCalls[idx], ...chunk.toolCall }
    } else {
      toolCalls.push({
        id: chunk.toolCall.id || '',
        name: chunk.toolCall.name || '',
        arguments: chunk.toolCall.arguments || '',
        status: chunk.toolCall.status || 'completed',
        result: chunk.toolCall.result,
        error: chunk.toolCall.error,
        resultFilePath: chunk.toolCall.resultFilePath,
      })
    }
    return { ...message, toolCalls }
  }

  if (chunk.type === 'iteration-end') {
    const blocks = [...(message.contentBlocks || [])]
    blocks.push({ type: 'iteration-end', iterationIndex: chunk.iterationIndex })
    return { ...message, contentBlocks: blocks, iterationIndex: chunk.iterationIndex }
  }

  if (chunk.type === 'reconnect') {
    const blocks = [...(message.contentBlocks || [])]
    if (blocks.length === 0) {
      return {
        ...message,
        content: '',
        contentBlocks: [],
        // Reconnect retries should restart visible thinking from a clean slate;
        // otherwise repeated reasoning chunks accumulate into duplicated noise.
        thinking: '',
      }
    }

    let boundaryIndex = -1
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === 'iteration-end') {
        boundaryIndex = i
        break
      }
    }

    const keptBlocks = boundaryIndex >= 0 ? blocks.slice(0, boundaryIndex + 1) : []
    const nextContent = keptBlocks
      .filter(block => block.type === 'text')
      .map(block => block.content || '')
      .join('')

    const keptToolCallIds = new Set(
      keptBlocks
        .filter(block => block.type === 'tool-call')
        .map(block => block.toolCallId)
        .filter(Boolean) as string[],
    )

    const nextToolCalls = message.toolCalls && message.toolCalls.length > 0
      ? message.toolCalls.filter(toolCall => keptToolCallIds.has(toolCall.id))
      : message.toolCalls

    return {
      ...message,
      content: nextContent,
      contentBlocks: keptBlocks,
      toolCalls: nextToolCalls,
      // Thinking text is not segmented by iteration, so on reconnect we cannot
      // safely preserve only the kept portion. Reset it and let the retried
      // request stream fresh reasoning chunks.
      thinking: '',
    }
  }

  return message
}

export const useCopilotStore = create<CopilotState>((set, get) => ({
  appMode: 'onit',
  messages: [],
  isRunning: false,
  activeRunId: null,
  tasks: [],
  selectedTaskId: null,
  taskDetailOpen: false,

  setAppMode: (mode) => set({ appMode: mode }),

  addMessage: (msg) => set(state => ({
    messages: [...state.messages, msg],
  })),

  startRun: (userMsg, assistantMsg, runId) => set(state => {
    // Clear any lingering isStreaming from previous runs before adding new messages
    const cleaned = state.messages.map(m =>
      m.role === 'assistant' && m.isStreaming ? { ...m, isStreaming: false } : m
    )
    return {
      messages: [...cleaned, userMsg, assistantMsg],
      isRunning: true,
      activeRunId: runId,
    }
  }),

  completeRun: (runId, result) => set(state => {
    // Accept completion for current run OR any run that matches a streaming message
    const isCurrentRun = state.activeRunId === runId
    const messages = [...state.messages]

    // Always clear isStreaming on ALL streaming assistant messages
    let changed = false
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].isStreaming) {
        messages[i] = { ...messages[i], isStreaming: false }
        changed = true
      }
    }

    if (isCurrentRun) {
      return { messages, isRunning: false, activeRunId: null }
    }
    return changed ? { messages } : state
  }),

  applyStreamChunks: (runId, chunks) => {
    if (chunks.length === 0) return
    set(state => {
      if (state.activeRunId !== runId || state.messages.length === 0) return state
      const messages = [...state.messages]
      const lastIdx = messages.length - 1
      let last = messages[lastIdx]
      if (last.role !== 'assistant') return state

      // Auto-acknowledge: if first meaningful output is a tool call and no content yet,
      // prepend an acknowledgment so the user sees immediate feedback
      if (!last.content && chunks.some(c => c.type === 'tool-call-start') && !chunks.some(c => c.type === 'content')) {
        last = { ...last, content: '好的，我来处理。\n\n' }
      }

      for (const chunk of chunks) {
        last = applyChunkToMessage(last, chunk)
      }
      messages[lastIdx] = last
      return { messages }
    })
  },

  addTask: (task) => set(state => {
    const existingIndex = state.tasks.findIndex(t => t.id === task.id)
    if (existingIndex >= 0) {
      const tasks = [...state.tasks]
      tasks[existingIndex] = { ...tasks[existingIndex], ...task }
      return { tasks }
    }

    return {
      tasks: [task, ...state.tasks],
    }
  }),

  updateTask: (taskId, updates) => set(state => {
    const existingIndex = state.tasks.findIndex(t => t.id === taskId)
    if (existingIndex < 0) {
      if (updates.id !== taskId) return state
      return { tasks: [updates as CopilotTask, ...state.tasks] }
    }

    const tasks = [...state.tasks]
    tasks[existingIndex] = { ...tasks[existingIndex], ...updates }
    return { tasks }
  }),

  removeTask: (taskId) => set(state => ({
    tasks: state.tasks.filter(t => t.id !== taskId),
    selectedTaskId: state.selectedTaskId === taskId ? null : state.selectedTaskId,
  })),

  selectTask: (taskId) => set({
    selectedTaskId: taskId,
    taskDetailOpen: taskId !== null,
  }),

  setTaskDetailOpen: (open) => set(open ? { taskDetailOpen: true } : { taskDetailOpen: false, selectedTaskId: null }),

  loadCopilotData: async () => {
    try {
      const data = await window.electronAPI.loadCopilotData()
      if (data) {
        set({
          messages: data.messages || [],
          tasks: data.tasks || [],
        })
      }
    } catch { /* ignore */ }
  },

  saveCopilotData: async () => {
    try {
      const { messages, tasks } = get()
      await window.electronAPI.saveCopilotData({ messages, tasks })
    } catch { /* ignore */ }
  },

  clearMessages: () => set({ messages: [] }),
}))
