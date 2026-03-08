import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { Session, Message, SessionStatus, PermissionMode, TaskItem, WorkspaceFile, ToolCall, ContentBlock } from '../types'

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
  deleteSession: (id: string) => Promise<void>
  setActiveSession: (id: string) => void
  updateSession: (id: string, updates: Partial<Session>) => void
  addMessage: (sessionId: string, message: Message) => void
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
  createdAt: Date.now(),
  updatedAt: Date.now(),
  isBackgroundRunning: false,
  backgroundCompleted: false,
  hasUnviewedResult: false,
})

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoading: false,

  loadSessions: async () => {
    set({ isLoading: true })
    try {
      const sessions = await window.electronAPI.loadSessions()
      if (sessions.length > 0) {
        // Clear stale background/unviewed flags on load —
        // sessions that aren't actually running shouldn't show as active tasks
        const cleaned = sessions.map((s: Session) => {
          if (s.status !== 'running' && (s.isBackgroundRunning || s.hasUnviewedResult || s.backgroundCompleted)) {
            return { ...s, isBackgroundRunning: false, hasUnviewedResult: false, backgroundCompleted: false }
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
    if (targetSession && (targetSession.hasUnviewedResult || targetSession.backgroundCompleted)) {
      set(state => ({
        sessions: state.sessions.map(s =>
          s.id === id ? { ...s, hasUnviewedResult: false, backgroundCompleted: false } : s
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
