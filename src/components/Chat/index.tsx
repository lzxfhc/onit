import { useEffect, useRef } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { v4 as uuidv4 } from 'uuid'
import MessageList from './MessageList'
import InputBox from './InputBox'
import TaskStatusPanel from './TaskStatus'
import type { Message } from '../../types'

export default function ChatView() {
  const {
    sessions, activeSessionId, addMessage, updateLastMessage,
    appendToLastMessage, setSessionStatus, updateTasks,
    updateWorkspaceFiles, updateToolCall, saveSession, getActiveSession,
  } = useSessionStore()
  const { settings, addPermissionRequest } = useSettingsStore()
  const cleanupRef = useRef<(() => void)[]>([])

  const activeSession = getActiveSession()

  // Set up IPC listeners
  useEffect(() => {
    // Clean up previous listeners
    cleanupRef.current.forEach(fn => fn())
    cleanupRef.current = []

    const unsubStream = window.electronAPI.onAgentStream((data: any) => {
      const { sessionId, chunk } = data
      if (chunk.type === 'content' && chunk.content) {
        appendToLastMessage(sessionId, chunk.content)
      } else if (chunk.type === 'thinking' && chunk.content) {
        // Use getState() to avoid stale closure
        const currentSessions = useSessionStore.getState().sessions
        const session = currentSessions.find(s => s.id === sessionId)
        if (session) {
          const lastMsg = session.messages[session.messages.length - 1]
          if (lastMsg?.role === 'assistant') {
            updateLastMessage(sessionId, {
              thinking: (lastMsg.thinking || '') + chunk.content,
            })
          }
        }
      } else if (chunk.type === 'tool-call-start' && chunk.toolCall) {
        updateToolCall(sessionId, chunk.toolCall)
      } else if (chunk.type === 'tool-call-result' && chunk.toolCall) {
        updateToolCall(sessionId, chunk.toolCall)
      }
    })

    const unsubComplete = window.electronAPI.onAgentComplete((data: any) => {
      setSessionStatus(data.sessionId, 'idle')
      updateLastMessage(data.sessionId, { isStreaming: false })
      saveSession(data.sessionId)
    })

    const unsubError = window.electronAPI.onAgentError((data: any) => {
      setSessionStatus(data.sessionId, 'error')
      const errorMsg: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: `Error: ${data.error}`,
        timestamp: Date.now(),
      }
      addMessage(data.sessionId, errorMsg)
      saveSession(data.sessionId)
    })

    const unsubPermission = window.electronAPI.onPermissionRequest((data: any) => {
      addPermissionRequest(data)
    })

    const unsubTaskUpdate = window.electronAPI.onTaskUpdate((data: any) => {
      updateTasks(data.sessionId, data.tasks)
    })

    const unsubWorkspaceFiles = window.electronAPI.onWorkspaceFiles((data: any) => {
      updateWorkspaceFiles(data.sessionId, data.files)
    })

    cleanupRef.current = [unsubStream, unsubComplete, unsubError, unsubPermission, unsubTaskUpdate, unsubWorkspaceFiles]

    return () => {
      cleanupRef.current.forEach(fn => fn())
    }
  }, [])

  const handleSendMessage = async (content: string) => {
    if (!activeSession || !content.trim()) return

    // Add user message
    const userMsg: Message = {
      id: uuidv4(),
      role: 'user',
      content: content.trim(),
      timestamp: Date.now(),
    }
    addMessage(activeSession.id, userMsg)

    // Add assistant placeholder
    const assistantMsg: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [],
    }
    addMessage(activeSession.id, assistantMsg)
    setSessionStatus(activeSession.id, 'running')

    // Auto-name session on first message
    if (activeSession.messages.length === 0) {
      const name = content.trim().substring(0, 40) + (content.length > 40 ? '...' : '')
      useSessionStore.getState().updateSession(activeSession.id, { name })
    }

    // Start agent
    try {
      await window.electronAPI.startAgent({
        sessionId: activeSession.id,
        message: content.trim(),
        session: {
          ...activeSession,
          apiConfig: settings.apiConfig,
        },
      })
    } catch (err: any) {
      setSessionStatus(activeSession.id, 'error')
      updateLastMessage(activeSession.id, {
        content: `Failed to start agent: ${err.message}`,
        isStreaming: false,
      })
    }
  }

  const handleStopAgent = async () => {
    if (!activeSession) return
    try {
      await window.electronAPI.stopAgent({ sessionId: activeSession.id })
      setSessionStatus(activeSession.id, 'idle')
      updateLastMessage(activeSession.id, { isStreaming: false })
    } catch {}
  }

  if (!activeSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
        Select or create a session to get started
      </div>
    )
  }

  return (
    <div className="flex-1 flex min-h-0">
      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <MessageList
          messages={activeSession.messages}
          isRunning={activeSession.status === 'running'}
        />
        <InputBox
          onSend={handleSendMessage}
          onStop={handleStopAgent}
          isRunning={activeSession.status === 'running'}
          session={activeSession}
        />
      </div>

      {/* Task Status Panel (right side) */}
      {(activeSession.tasks.length > 0 || activeSession.workspaceFiles.length > 0 ||
        activeSession.messages.some(m => m.toolCalls && m.toolCalls.length > 0)) && (
        <TaskStatusPanel session={activeSession} />
      )}
    </div>
  )
}
