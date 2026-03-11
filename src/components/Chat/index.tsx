import { useCallback, useEffect, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import MessageList from './MessageList'
import InputBox from './InputBox'
import TaskStatusPanel from './TaskStatus'
import type { Message, StreamChunk } from '../../types'

function isCurrentRun(sessionId: string, runId?: string) {
  if (!runId) return false
  const session = useSessionStore.getState().sessions.find(s => s.id === sessionId)
  return session?.activeRunId === runId
}

function getRunKey(sessionId: string, runId: string) {
  return `${sessionId}:${runId}`
}

interface PendingStreamChunks {
  sessionId: string
  runId: string
  chunks: StreamChunk[]
}

export default function ChatView({ rightPanelOpen }: { rightPanelOpen: boolean }) {
  const activeSession = useSessionStore(state =>
    state.sessions.find(session => session.id === state.activeSessionId) || null,
  )
  const pendingStreamChunksRef = useRef<Map<string, PendingStreamChunks>>(new Map())
  const pendingAnimationFrameRef = useRef<number | null>(null)

  const flushPendingStreamChunks = useCallback((targetKey?: string) => {
    const pending = pendingStreamChunksRef.current
    const sessionStore = useSessionStore.getState()
    const targets = targetKey
      ? (() => {
          const entry = pending.get(targetKey)
          return entry ? [[targetKey, entry] as const] : []
        })()
      : Array.from(pending.entries())

    for (const [key, payload] of targets) {
      pending.delete(key)
      if (payload.chunks.length > 0) {
        sessionStore.applyStreamChunks(payload.sessionId, payload.runId, payload.chunks)
      }
    }
  }, [])

  const schedulePendingStreamFlush = useCallback(() => {
    if (pendingAnimationFrameRef.current !== null) return

    pendingAnimationFrameRef.current = window.requestAnimationFrame(() => {
      pendingAnimationFrameRef.current = null
      flushPendingStreamChunks()
    })
  }, [flushPendingStreamChunks])

  useEffect(() => {
    const flushRun = (sessionId: string, runId: string) => {
      flushPendingStreamChunks(getRunKey(sessionId, runId))
    }

    const unsubStream = window.electronAPI.onAgentStream((data: any) => {
      const { sessionId, runId, chunk } = data
      const key = getRunKey(sessionId, runId)
      const existing = pendingStreamChunksRef.current.get(key)

      if (existing) {
        existing.chunks.push(chunk)
      } else {
        pendingStreamChunksRef.current.set(key, {
          sessionId,
          runId,
          chunks: [chunk],
        })
      }

      schedulePendingStreamFlush()
    })

    const unsubComplete = window.electronAPI.onAgentComplete((data: any) => {
      const { sessionId, runId, status } = data
      flushRun(sessionId, runId)
      useSessionStore.getState().completeRun(sessionId, runId, status)
      useSettingsStore.getState().removePermissionRequestsForSession(sessionId, runId)
      useSessionStore.getState().saveSession(sessionId)
    })

    const unsubError = window.electronAPI.onAgentError((data: any) => {
      const { sessionId, runId, error } = data
      flushRun(sessionId, runId)

      const sessionStore = useSessionStore.getState()
      const session = sessionStore.sessions.find(s => s.id === sessionId)
      const lastMessage = session?.messages[session.messages.length - 1]
      const belongsToCurrentRun = session?.activeRunId === runId || lastMessage?.runId === runId

      if (!belongsToCurrentRun) return

      sessionStore.completeRun(sessionId, runId, 'error')
      useSettingsStore.getState().removePermissionRequestsForSession(sessionId, runId)

      const errorMsg: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: `Error: ${error}`,
        timestamp: Date.now(),
        runId,
      }
      sessionStore.addMessage(sessionId, errorMsg)
      sessionStore.saveSession(sessionId)
    })

    const unsubPermission = window.electronAPI.onPermissionRequest((data: any) => {
      if (!isCurrentRun(data.sessionId, data.runId)) return
      useSettingsStore.getState().addPermissionRequest(data)
    })

    const unsubTaskUpdate = window.electronAPI.onTaskUpdate((data: any) => {
      if (!isCurrentRun(data.sessionId, data.runId)) return
      useSessionStore.getState().updateTasks(data.sessionId, data.tasks)
    })

    const unsubWorkspaceFiles = window.electronAPI.onWorkspaceFiles((data: any) => {
      if (!isCurrentRun(data.sessionId, data.runId)) return
      useSessionStore.getState().updateWorkspaceFiles(data.sessionId, data.files)
    })

    return () => {
      if (pendingAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingAnimationFrameRef.current)
        pendingAnimationFrameRef.current = null
      }
      flushPendingStreamChunks()
      unsubStream()
      unsubComplete()
      unsubError()
      unsubPermission()
      unsubTaskUpdate()
      unsubWorkspaceFiles()
    }
  }, [flushPendingStreamChunks, schedulePendingStreamFlush])

  const handleSendMessage = useCallback(async (content: string) => {
    const trimmedContent = content.trim()
    if (!trimmedContent) return

    const sessionStore = useSessionStore.getState()
    const settingsStore = useSettingsStore.getState()
    const activeSessionId = sessionStore.activeSessionId

    if (!activeSessionId) return

    const latestSession = sessionStore.sessions.find(session => session.id === activeSessionId)
    if (!latestSession) return

    const runId = uuidv4()
    const now = Date.now()

    const userMsg: Message = {
      id: uuidv4(),
      role: 'user',
      content: trimmedContent,
      timestamp: now,
    }

    const assistantMsg: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: now,
      isStreaming: true,
      toolCalls: [],
      contentBlocks: [],
      runId,
    }

    sessionStore.startAssistantRun(latestSession.id, userMsg, assistantMsg, runId)
    settingsStore.removePermissionRequestsForSession(latestSession.id)

    if (latestSession.messages.length === 0) {
      const name = trimmedContent.substring(0, 40) + (trimmedContent.length > 40 ? '...' : '')
      sessionStore.updateSession(latestSession.id, { name })
    }

    try {
      await window.electronAPI.startAgent({
        sessionId: latestSession.id,
        message: trimmedContent,
        runId,
        session: {
          ...latestSession,
          activeRunId: runId,
          apiConfig: settingsStore.settings.apiConfig,
        },
      })
    } catch (err: any) {
      sessionStore.completeRun(latestSession.id, runId, 'error')
      settingsStore.removePermissionRequestsForSession(latestSession.id, runId)
      sessionStore.addMessage(latestSession.id, {
        id: uuidv4(),
        role: 'assistant',
        content: `Failed to start agent: ${err.message}`,
        timestamp: Date.now(),
        runId,
      })
    }
  }, [])

  const handleStopAgent = useCallback(async () => {
    const sessionStore = useSessionStore.getState()
    const settingsStore = useSettingsStore.getState()
    const activeSessionId = sessionStore.activeSessionId

    if (!activeSessionId) return

    const session = sessionStore.sessions.find(item => item.id === activeSessionId)
    if (!session?.activeRunId) return

    const runId = session.activeRunId

    try {
      await window.electronAPI.stopAgent({ sessionId: session.id })
    } finally {
      sessionStore.completeRun(session.id, runId, 'stopped')
      settingsStore.removePermissionRequestsForSession(session.id, runId)
    }
  }, [])

  if (!activeSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
        Select or create a session to get started
      </div>
    )
  }

  return (
    <div className="flex-1 flex min-h-0">
      <div className="flex-1 flex flex-col min-w-0">
        <MessageList
          messages={activeSession.messages}
          isRunning={activeSession.status === 'running'}
        />
        <InputBox
          onSend={handleSendMessage}
          onStop={handleStopAgent}
          isRunning={activeSession.status === 'running'}
          sessionId={activeSession.id}
        />
      </div>

      <div
        className={`shrink-0 transition-[width] duration-200 ease-out overflow-hidden ${
          rightPanelOpen ? 'w-72' : 'w-0'
        }`}
        aria-hidden={!rightPanelOpen}
      >
        <div
          className={`w-72 h-full transition-opacity duration-200 ${
            rightPanelOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <TaskStatusPanel session={activeSession} />
        </div>
      </div>
    </div>
  )
}
