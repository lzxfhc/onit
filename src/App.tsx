import { useCallback, useEffect, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { shallow } from 'zustand/shallow'
import { useSettingsStore } from './stores/settingsStore'
import { useSessionStore } from './stores/sessionStore'
import { useCopilotStore } from './stores/copilotStore'
import Login from './components/Login'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import ChatView from './components/Chat'
import CopilotView from './components/CopilotView'
import PermissionDialog from './components/Dialogs/PermissionDialog'
import QuestionDialog from './components/Dialogs/QuestionDialog'
import PlanApprovalDialog from './components/Dialogs/PlanApprovalDialog'
import { ErrorBoundary } from './components/ErrorBoundary'
import type { Message, ScheduledSessionCreatedEvent, Session, StreamChunk } from './types'

interface PendingCopilotChunks {
  runId: string
  chunks: StreamChunk[]
}

export default function App() {
  const { isLoggedIn, loadSettings, loadScheduledTasks, loadSkills, permissionRequests } = useSettingsStore((state) => ({
    isLoggedIn: state.isLoggedIn,
    loadSettings: state.loadSettings,
    loadScheduledTasks: state.loadScheduledTasks,
    loadSkills: state.loadSkills,
    permissionRequests: state.permissionRequests,
  }), shallow)
  const { loadSessions, activeSessionId } = useSessionStore((state) => ({
    loadSessions: state.loadSessions,
    activeSessionId: state.activeSessionId,
  }), shallow)
  const appMode = useCopilotStore(s => s.appMode)

  const [rightPanelOpen, setRightPanelOpen] = useState(true)

  // --- Copilot stream buffering (mirrors Chat/index.tsx pattern) ---
  const pendingCopilotChunksRef = useRef<Map<string, PendingCopilotChunks>>(new Map())
  const pendingCopilotAnimFrameRef = useRef<number | null>(null)

  const flushCopilotChunks = useCallback((targetRunId?: string) => {
    const pending = pendingCopilotChunksRef.current
    const copilotStore = useCopilotStore.getState()
    const targets = targetRunId
      ? (() => {
          const entry = pending.get(targetRunId)
          return entry ? [[targetRunId, entry] as const] : []
        })()
      : Array.from(pending.entries())

    for (const [key, payload] of targets) {
      pending.delete(key)
      if (payload.chunks.length > 0) {
        copilotStore.applyStreamChunks(payload.runId, payload.chunks)
      }
    }
  }, [])

  const scheduleCopilotFlush = useCallback(() => {
    if (pendingCopilotAnimFrameRef.current !== null) return

    pendingCopilotAnimFrameRef.current = window.requestAnimationFrame(() => {
      pendingCopilotAnimFrameRef.current = null
      flushCopilotChunks()
    })
  }, [flushCopilotChunks])

  useEffect(() => {
    loadSettings()
  }, [])

  useEffect(() => {
    if (!isLoggedIn) return

    loadSessions()
    loadScheduledTasks()
    loadSkills()
    useCopilotStore.getState().loadCopilotData()

    // --- Scheduler session created listener (existing) ---
    const unsubScheduler = window.electronAPI.onSchedulerSessionCreated((data: ScheduledSessionCreatedEvent) => {
      const now = Date.now()
      const userMessage: Message = {
        id: uuidv4(),
        role: 'user',
        content: data.taskPrompt,
        timestamp: now,
      }
      const assistantMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: '',
        timestamp: now,
        isStreaming: true,
        toolCalls: [],
        contentBlocks: [],
        runId: data.runId,
      }
      const session: Session = {
        id: data.sessionId,
        name: data.taskName,
        messages: [userMessage, assistantMessage],
        status: 'running',
        activeRunId: data.runId,
        permissionMode: data.permissionMode || 'accept-edit',
        workspacePath: data.workspacePath || null,
        attachedFiles: [],
        model: data.model || 'qianfan-code-latest',
        tasks: [],
        workspaceFiles: [],
        sessionMemory: null,
        createdAt: now,
        updatedAt: now,
        isBackgroundRunning: !data.openInForeground,
        backgroundCompleted: false,
        hasUnviewedResult: false,
      }

      const sessionStore = useSessionStore.getState()
      sessionStore.registerExternalSession(session)
      if (data.openInForeground) {
        sessionStore.setActiveSession(session.id)
      }
      sessionStore.saveSession(session.id)
    })

    // --- Copilot IPC listeners ---
    const unsubCopilotStream = window.electronAPI.onCopilotStream?.((data: any) => {
      const { runId, chunk } = data
      const existing = pendingCopilotChunksRef.current.get(runId)

      if (existing) {
        existing.chunks.push(chunk)
      } else {
        pendingCopilotChunksRef.current.set(runId, {
          runId,
          chunks: [chunk],
        })
      }

      scheduleCopilotFlush()
    })

    const unsubCopilotComplete = window.electronAPI.onCopilotComplete?.((data: any) => {
      const { runId, status } = data
      flushCopilotChunks(runId)
      useCopilotStore.getState().completeRun(runId, status || 'completed')
      // Persist conversation after each run
      useCopilotStore.getState().saveCopilotData()
    })

    const unsubCopilotError = window.electronAPI.onCopilotError?.((data: any) => {
      const { runId, error } = data
      flushCopilotChunks(runId)

      const copilotStore = useCopilotStore.getState()
      copilotStore.completeRun(runId, 'error')
      copilotStore.addMessage({
        id: uuidv4(),
        role: 'assistant',
        content: `Error: ${error}`,
        timestamp: Date.now(),
        runId,
      })
      copilotStore.saveCopilotData()
    })

    const unsubCopilotTaskEvent = window.electronAPI.onCopilotTaskEvent?.((data: any) => {
      const copilotStore = useCopilotStore.getState()
      if (data.type === 'created') {
        copilotStore.addTask(data.task)
      } else if (data.type === 'removed') {
        copilotStore.removeTask(data.task?.id || data.taskId)
      } else {
        copilotStore.updateTask(data.task?.id || data.taskId, data.task || data.updates || {})
      }
    })

    // Task result: inject completed task result as an assistant message (fallback for failed tasks)
    const unsubCopilotTaskResult = window.electronAPI.onCopilotTaskResult?.((data: any) => {
      const copilotStore = useCopilotStore.getState()
      copilotStore.addMessage({
        id: uuidv4(),
        role: 'assistant',
        content: data.content || '',
        timestamp: Date.now(),
        runId: data.runId,
      })
      copilotStore.saveCopilotData()
    })

    // Auto-report: when a worker task completes, trigger main Agent to summarize results
    const unsubCopilotAutoReport = window.electronAPI.onCopilotAutoReport?.((data: any) => {
      const copilotStore = useCopilotStore.getState()
      const settingsStore = useSettingsStore.getState()

      // Don't trigger if main Agent is already running
      if (copilotStore.isRunning) return

      const { runId, message, taskName } = data
      const now = Date.now()

      // Create system message (hidden from UI) + assistant placeholder
      const systemMsg: Message = {
        id: uuidv4(),
        role: 'user',
        content: message,
        timestamp: now,
        isSystem: true, // Hidden from UI
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

      copilotStore.startRun(systemMsg, assistantMsg, runId)

      // Trigger orchestrator to read and summarize the result
      const prevMessages = copilotStore.messages.slice(0, -2)
      window.electronAPI.startCopilot?.({
        message,
        runId,
        apiConfig: settingsStore.settings.apiConfig,
        messages: prevMessages,
      }).catch(() => {
        copilotStore.completeRun(runId, 'error')
      })
    })

    return () => {
      // Cancel pending animation frame
      if (pendingCopilotAnimFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingCopilotAnimFrameRef.current)
        pendingCopilotAnimFrameRef.current = null
      }
      flushCopilotChunks()

      unsubScheduler()
      unsubCopilotStream?.()
      unsubCopilotComplete?.()
      unsubCopilotError?.()
      unsubCopilotTaskEvent?.()
      unsubCopilotTaskResult?.()
      unsubCopilotAutoReport?.()
    }
  }, [isLoggedIn, loadSessions, loadScheduledTasks, loadSkills, flushCopilotChunks, scheduleCopilotFlush])

  if (!isLoggedIn) {
    return <Login />
  }

  const isCopilot = appMode === 'copilot'
  const backgroundInteractiveRequest = permissionRequests.find(req =>
    (isCopilot || req.sessionId !== activeSessionId) &&
    (req.type === 'user-question' || req.type === 'plan-approval')
  )

  return (
    <div className="flex h-screen bg-canvas overflow-hidden">
      {/* Top Bar */}
      <TopBar
        rightPanelOpen={rightPanelOpen}
        onToggleRightPanel={() => setRightPanelOpen(prev => !prev)}
      />

      {/* Onit mode: Sidebar + ChatView */}
      {!isCopilot && <Sidebar />}

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 pt-12">
        <ErrorBoundary>
          {isCopilot ? (
            <CopilotView />
          ) : (
            <ChatView rightPanelOpen={rightPanelOpen} />
          )}
        </ErrorBoundary>
      </main>

      {/* Permission dialogs. Active-session question/plan requests render inline in ChatView.
          Background-session interactive requests still need a global fallback so they do not block invisibly. */}
      {permissionRequests
        .filter(req => req.type !== 'user-question' && req.type !== 'plan-approval')
        .map(req => <PermissionDialog key={req.id} request={req} />)
      }
      {backgroundInteractiveRequest?.type === 'user-question' && (
        <QuestionDialog request={backgroundInteractiveRequest} />
      )}
      {backgroundInteractiveRequest?.type === 'plan-approval' && (
        <PlanApprovalDialog request={backgroundInteractiveRequest} />
      )}
    </div>
  )
}
