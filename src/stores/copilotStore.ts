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
    return { ...message, content: message.content + chunk.content }
  }
  if (chunk.type === 'thinking' && chunk.content) {
    return { ...message, thinking: (message.thinking || '') + chunk.content }
  }
  if (chunk.type === 'tool-call-start' && chunk.toolCall) {
    const toolCalls = [...(message.toolCalls || [])]
    toolCalls.push({
      id: chunk.toolCall.id || '',
      name: chunk.toolCall.name || '',
      arguments: chunk.toolCall.arguments || '',
      status: 'running',
    })
    return { ...message, toolCalls }
  }
  if (chunk.type === 'tool-call-result' && chunk.toolCall) {
    const toolCalls = [...(message.toolCalls || [])]
    const idx = toolCalls.findIndex(tc => tc.id === chunk.toolCall!.id)
    if (idx >= 0) {
      toolCalls[idx] = { ...toolCalls[idx], ...chunk.toolCall }
    }
    return { ...message, toolCalls }
  }
  if (chunk.type === 'iteration-end') {
    const blocks = [...(message.contentBlocks || [])]
    blocks.push({ type: 'iteration-end', iterationIndex: chunk.iterationIndex })
    return { ...message, contentBlocks: blocks }
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

  startRun: (userMsg, assistantMsg, runId) => set(state => ({
    messages: [...state.messages, userMsg, assistantMsg],
    isRunning: true,
    activeRunId: runId,
  })),

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
      for (const chunk of chunks) {
        last = applyChunkToMessage(last, chunk)
      }
      messages[lastIdx] = last
      return { messages }
    })
  },

  addTask: (task) => set(state => ({
    tasks: [task, ...state.tasks],
  })),

  updateTask: (taskId, updates) => set(state => ({
    tasks: state.tasks.map(t => t.id === taskId ? { ...t, ...updates } : t),
  })),

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
