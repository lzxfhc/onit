import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type {
  Session,
  Message,
  SessionStatus,
  PermissionMode,
  TaskItem,
  WorkspaceFile,
  ToolCall,
  ContentBlock,
  StreamChunk,
} from '../types'

declare global {
  interface Window {
    electronAPI: any
  }
}

interface SessionState {
  sessions: Session[]
  activeSessionId: string | null
  isLoading: boolean

  // Actions
  loadSessions: () => Promise<void>
  createSession: (name?: string) => Session
  registerExternalSession: (session: Session) => void
  deleteSession: (id: string) => Promise<void>
  setActiveSession: (id: string) => void
  updateSession: (id: string, updates: Partial<Session>) => void
  addMessage: (sessionId: string, message: Message) => void
  startAssistantRun: (sessionId: string, userMessage: Message, assistantMessage: Message, runId: string) => void
  updateLastMessage: (sessionId: string, updates: Partial<Message>) => void
  appendToLastMessage: (sessionId: string, content: string) => void
  setSessionStatus: (sessionId: string, status: SessionStatus) => void
  setWorkspace: (sessionId: string, path: string | null) => void
  setPermissionMode: (sessionId: string, mode: PermissionMode) => void
  setModel: (sessionId: string, model: string) => void
  addAttachedFile: (sessionId: string, filePath: string) => void
  removeAttachedFile: (sessionId: string, filePath: string) => void
  updateTasks: (sessionId: string, tasks: TaskItem[]) => void
  updateWorkspaceFiles: (sessionId: string, files: WorkspaceFile[]) => void
  updateToolCall: (sessionId: string, toolCall: ToolCall) => void
  applyStreamChunk: (sessionId: string, runId: string, chunk: StreamChunk) => void
  applyStreamChunks: (sessionId: string, runId: string, chunks: StreamChunk[]) => void
  completeRun: (sessionId: string, runId: string, result: 'completed' | 'stopped' | 'error') => void
  appendContentBlock: (sessionId: string, block: ContentBlock) => void
  addIterationEndMarker: (sessionId: string, iterationIndex: number) => void
  markSessionViewed: (sessionId: string) => void
  saveSession: (sessionId: string) => Promise<void>

  // Computed
  getActiveSession: () => Session | null
  getRunningSessionIds: () => string[]
}

const createDefaultSession = (name?: string): Session => ({
  id: uuidv4(),
  name: name || `New Session`,
  messages: [],
  status: 'idle',
  permissionMode: 'accept-edit',
  workspacePath: null,
  attachedFiles: [],
  model: 'qianfan-code-latest',
  tasks: [],
  workspaceFiles: [],
  sessionMemory: null,
  activeRunId: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  isBackgroundRunning: false,
  backgroundCompleted: false,
  hasUnviewedResult: false,
})

function upsertToolCall(toolCalls: ToolCall[] | undefined, nextToolCall: ToolCall): ToolCall[] {
  const nextCalls = toolCalls ? [...toolCalls] : []
  const existingIndex = nextCalls.findIndex(toolCall => toolCall.id === nextToolCall.id)

  if (existingIndex >= 0) {
    nextCalls[existingIndex] = nextToolCall
  } else {
    nextCalls.push(nextToolCall)
  }

  return nextCalls
}

function applyChunkToAssistantMessage(message: Message, chunk: StreamChunk): Message {
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
    return {
      ...message,
      thinking: (message.thinking || '') + chunk.content,
    }
  }

  if (chunk.type === 'tool-call-start' && chunk.toolCall) {
    const blocks = message.contentBlocks ? [...message.contentBlocks] : []
    blocks.push({ type: 'tool-call', toolCallId: chunk.toolCall.id })

    return {
      ...message,
      toolCalls: upsertToolCall(message.toolCalls, chunk.toolCall),
      contentBlocks: blocks,
    }
  }

  if (chunk.type === 'tool-call-result' && chunk.toolCall) {
    return {
      ...message,
      toolCalls: upsertToolCall(message.toolCalls, chunk.toolCall),
    }
  }

  if (chunk.type === 'iteration-end') {
    const blocks = message.contentBlocks ? [...message.contentBlocks] : []
    blocks.push({ type: 'iteration-end', iterationIndex: chunk.iterationIndex })

    return {
      ...message,
      contentBlocks: blocks,
      iterationIndex: chunk.iterationIndex,
    }
  }

  if (chunk.type === 'reconnect') {
    const blocks = message.contentBlocks ? [...message.contentBlocks] : []
    if (blocks.length === 0) {
      return { ...message, content: '', contentBlocks: [] }
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
    }
  }

  return message
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoading: false,

  loadSessions: async () => {
    set({ isLoading: true })
    try {
      const sessions = await window.electronAPI.loadSessions()
      if (sessions.length > 0) {
        // Agents do not survive app restarts. Clear stale runtime flags on load.
        const cleaned = sessions.map((s: Session) => {
          if (s.status === 'running' || s.activeRunId || s.isBackgroundRunning || s.hasUnviewedResult || s.backgroundCompleted) {
            return {
              ...s,
              status: 'idle' as SessionStatus,
              activeRunId: null,
              isBackgroundRunning: false,
              hasUnviewedResult: false,
              backgroundCompleted: false,
            }
          }
          return s
        })
        set({ sessions: cleaned, activeSessionId: cleaned[0].id, isLoading: false })
      } else {
        const newSession = createDefaultSession()
        set({ sessions: [newSession], activeSessionId: newSession.id, isLoading: false })
      }
    } catch {
      const newSession = createDefaultSession()
      set({ sessions: [newSession], activeSessionId: newSession.id, isLoading: false })
    }
  },

  createSession: (name?: string) => {
    const newSession = createDefaultSession(name)
    set(state => ({
      sessions: [newSession, ...state.sessions],
      activeSessionId: newSession.id,
    }))
    return newSession
  },

  registerExternalSession: (session) => {
    set(state => {
      const existing = state.sessions.find(item => item.id === session.id)
      if (existing) {
        return {
          sessions: state.sessions.map(item =>
            item.id === session.id
              ? { ...item, ...session, updatedAt: session.updatedAt || Date.now() }
              : item,
          ),
        }
      }

      return {
        sessions: [session, ...state.sessions],
        activeSessionId: state.activeSessionId || session.id,
      }
    })
  },

  deleteSession: async (id: string) => {
    await window.electronAPI.deleteSession({ id })
    set(state => {
      const filtered = state.sessions.filter(s => s.id !== id)
      let activeId = state.activeSessionId
      if (activeId === id) {
        activeId = filtered.length > 0 ? filtered[0].id : null
      }
      if (filtered.length === 0) {
        const newSession = createDefaultSession()
        return { sessions: [newSession], activeSessionId: newSession.id }
      }
      // Clear unviewed flags on the session we're auto-switching to
      const cleanedSessions = filtered.map(s =>
        s.id === activeId && (s.hasUnviewedResult || s.backgroundCompleted)
          ? { ...s, hasUnviewedResult: false, backgroundCompleted: false }
          : s
      )
      return { sessions: cleanedSessions, activeSessionId: activeId }
    })
    // Persist the cleaned session if we auto-switched
    const newActiveId = get().activeSessionId
    if (newActiveId) {
      get().saveSession(newActiveId)
    }
  },

  setActiveSession: (id: string) => {
    const state = get()
    const currentActive = state.activeSessionId
    const currentSession = state.sessions.find(s => s.id === currentActive)

    // If the current session is running, mark it as background
    if (currentSession && currentSession.status === 'running' && currentActive !== id) {
      set(state => ({
        sessions: state.sessions.map(s =>
          s.id === currentActive ? { ...s, isBackgroundRunning: true } : s
        ),
      }))
    }

    // Clear unviewed flags on the session we're switching TO
    const targetSession = state.sessions.find(s => s.id === id)
    if (targetSession && (targetSession.isBackgroundRunning || targetSession.hasUnviewedResult || targetSession.backgroundCompleted)) {
      set(state => ({
        sessions: state.sessions.map(s =>
          s.id === id
            ? { ...s, isBackgroundRunning: false, hasUnviewedResult: false, backgroundCompleted: false }
            : s
        ),
      }))
      // Persist so flags don't come back on restart
      get().saveSession(id)
    }

    set({ activeSessionId: id })
  },

  updateSession: (id, updates) => {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === id ? { ...s, ...updates, updatedAt: Date.now() } : s
      ),
    }))
  },

  addMessage: (sessionId, message) => {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, message], updatedAt: Date.now() }
          : s
      ),
    }))
  },

  startAssistantRun: (sessionId, userMessage, assistantMessage, runId) => {
    set(state => ({
      sessions: state.sessions.map(s => {
        if (s.id !== sessionId) return s
        return {
          ...s,
          messages: [...s.messages, userMessage, assistantMessage],
          activeRunId: runId,
          status: 'running',
          backgroundCompleted: false,
          hasUnviewedResult: false,
          updatedAt: Date.now(),
        }
      }),
    }))
  },

  updateLastMessage: (sessionId, updates) => {
    set(state => ({
      sessions: state.sessions.map(s => {
        if (s.id !== sessionId || s.messages.length === 0) return s
        const messages = [...s.messages]
        messages[messages.length - 1] = { ...messages[messages.length - 1], ...updates }
        return { ...s, messages }
      }),
    }))
  },

  appendToLastMessage: (sessionId, content) => {
    set(state => ({
      sessions: state.sessions.map(s => {
        if (s.id !== sessionId || s.messages.length === 0) return s
        const messages = [...s.messages]
        const last = messages[messages.length - 1]
        messages[messages.length - 1] = { ...last, content: last.content + content }
        return { ...s, messages }
      }),
    }))
  },

  setSessionStatus: (sessionId, status) => {
    set(state => ({
      sessions: state.sessions.map(s => {
        if (s.id !== sessionId) return s
        const updates: Partial<Session> = { status, updatedAt: Date.now() }
        if (status === 'completed' || status === 'error' || status === 'idle') {
          if (s.isBackgroundRunning) {
            updates.isBackgroundRunning = false
            updates.backgroundCompleted = true
            updates.hasUnviewedResult = true
          }
        }
        if (status === 'running') {
          updates.backgroundCompleted = false
        }
        return { ...s, ...updates }
      }),
    }))
  },

  setWorkspace: (sessionId, path) => {
    get().updateSession(sessionId, { workspacePath: path })
  },

  setPermissionMode: (sessionId, mode) => {
    get().updateSession(sessionId, { permissionMode: mode })
  },

  setModel: (sessionId, model) => {
    get().updateSession(sessionId, { model })
  },

  addAttachedFile: (sessionId, filePath) => {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId && !s.attachedFiles.includes(filePath)
          ? { ...s, attachedFiles: [...s.attachedFiles, filePath] }
          : s
      ),
    }))
  },

  removeAttachedFile: (sessionId, filePath) => {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId
          ? { ...s, attachedFiles: s.attachedFiles.filter(f => f !== filePath) }
          : s
      ),
    }))
  },

  updateTasks: (sessionId, tasks) => {
    get().updateSession(sessionId, { tasks })
  },

  updateWorkspaceFiles: (sessionId, files) => {
    get().updateSession(sessionId, { workspaceFiles: files })
  },

  updateToolCall: (sessionId, toolCall) => {
    set(state => ({
      sessions: state.sessions.map(s => {
        if (s.id !== sessionId || s.messages.length === 0) return s
        const messages = [...s.messages]
        const lastMsg = messages[messages.length - 1]
        if (lastMsg.role === 'assistant') {
          const toolCalls = lastMsg.toolCalls ? [...lastMsg.toolCalls] : []
          const existingIdx = toolCalls.findIndex(tc => tc.id === toolCall.id)
          if (existingIdx >= 0) {
            toolCalls[existingIdx] = toolCall
          } else {
            toolCalls.push(toolCall)
          }
          messages[messages.length - 1] = { ...lastMsg, toolCalls }
        }
        return { ...s, messages }
      }),
    }))
  },

  applyStreamChunk: (sessionId, runId, chunk) => {
    get().applyStreamChunks(sessionId, runId, [chunk])
  },

  applyStreamChunks: (sessionId, runId, chunks) => {
    if (chunks.length === 0) return

    set(state => ({
      sessions: state.sessions.map(s => {
        if (s.id !== sessionId || s.activeRunId !== runId || s.messages.length === 0) return s

        const messages = [...s.messages]
        const lastIndex = messages.length - 1
        const last = messages[lastIndex]

        if (last.role !== 'assistant' || last.runId !== runId) return s

        let nextLast = last
        for (const chunk of chunks) {
          nextLast = applyChunkToAssistantMessage(nextLast, chunk)
        }

        if (nextLast === last) return s

        messages[lastIndex] = nextLast
        return { ...s, messages }
      }),
    }))
  },

  completeRun: (sessionId, runId, result) => {
    set(state => ({
      sessions: state.sessions.map(s => {
        if (s.id !== sessionId || s.messages.length === 0) return s

        const messages = [...s.messages]
        const lastIndex = messages.length - 1
        const last = messages[lastIndex]
        const matchesRun = last.role === 'assistant' && last.runId === runId

        if (!matchesRun && s.activeRunId !== runId) return s

        if (matchesRun) {
          messages[lastIndex] = { ...last, isStreaming: false }
        }

        const wasBackgroundRunning = s.isBackgroundRunning
        const isSuccessfulCompletion = result === 'completed' || result === 'error'

        return {
          ...s,
          messages,
          activeRunId: s.activeRunId === runId ? null : s.activeRunId,
          status: result === 'error' ? 'error' : result === 'completed' ? 'completed' : 'idle',
          isBackgroundRunning: false,
          backgroundCompleted: wasBackgroundRunning && isSuccessfulCompletion,
          hasUnviewedResult: wasBackgroundRunning && isSuccessfulCompletion,
          updatedAt: Date.now(),
        }
      }),
    }))
  },

  markSessionViewed: (sessionId) => {
    get().updateSession(sessionId, { hasUnviewedResult: false, backgroundCompleted: false })
    // Persist to disk so stale flags don't reappear on restart
    get().saveSession(sessionId)
  },

  appendContentBlock: (sessionId, block) => {
    set(state => ({
      sessions: state.sessions.map(s => {
        if (s.id !== sessionId || s.messages.length === 0) return s
        const messages = [...s.messages]
        const last = messages[messages.length - 1]
        if (last.role !== 'assistant') return s

        const blocks = last.contentBlocks ? [...last.contentBlocks] : []
        // If both the last block and new block are text, merge them
        if (block.type === 'text' && blocks.length > 0 && blocks[blocks.length - 1].type === 'text') {
          blocks[blocks.length - 1] = {
            ...blocks[blocks.length - 1],
            content: (blocks[blocks.length - 1].content || '') + (block.content || ''),
          }
        } else {
          blocks.push(block)
        }
        messages[messages.length - 1] = { ...last, contentBlocks: blocks }
        return { ...s, messages }
      }),
    }))
  },

  addIterationEndMarker: (sessionId, iterationIndex) => {
    set(state => ({
      sessions: state.sessions.map(s => {
        if (s.id !== sessionId || s.messages.length === 0) return s
        const messages = [...s.messages]
        const last = messages[messages.length - 1]
        if (last.role !== 'assistant') return s
        // Append an iteration-end content block as boundary marker
        const blocks = last.contentBlocks ? [...last.contentBlocks] : []
        blocks.push({ type: 'iteration-end', iterationIndex })
        messages[messages.length - 1] = { ...last, contentBlocks: blocks, iterationIndex }
        return { ...s, messages }
      }),
    }))
  },

  saveSession: async (sessionId) => {
    const session = get().sessions.find(s => s.id === sessionId)
    if (session) {
      await window.electronAPI.saveSessions(session)
    }
  },

  getActiveSession: () => {
    const state = get()
    return state.sessions.find(s => s.id === state.activeSessionId) || null
  },

  getRunningSessionIds: () => {
    return get().sessions.filter(s => s.status === 'running' || s.isBackgroundRunning).map(s => s.id)
  },
}))
