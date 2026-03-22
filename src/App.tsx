import { useEffect, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { shallow } from 'zustand/shallow'
import { useSettingsStore } from './stores/settingsStore'
import { useSessionStore } from './stores/sessionStore'
import Login from './components/Login'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import ChatView from './components/Chat'
import PermissionDialog from './components/Dialogs/PermissionDialog'
import type { Message, ScheduledSessionCreatedEvent, Session } from './types'

export default function App() {
  const { isLoggedIn, loadSettings, loadScheduledTasks, loadSkills, permissionRequests } = useSettingsStore((state) => ({
    isLoggedIn: state.isLoggedIn,
    loadSettings: state.loadSettings,
    loadScheduledTasks: state.loadScheduledTasks,
    loadSkills: state.loadSkills,
    permissionRequests: state.permissionRequests,
  }), shallow)
  const { loadSessions } = useSessionStore((state) => ({
    loadSessions: state.loadSessions,
  }), shallow)

  const [rightPanelOpen, setRightPanelOpen] = useState(true)

  useEffect(() => {
    loadSettings()
  }, [])

  useEffect(() => {
    if (!isLoggedIn) return

    loadSessions()
    loadScheduledTasks()
    loadSkills()

    const unsubscribe = window.electronAPI.onSchedulerSessionCreated((data: ScheduledSessionCreatedEvent) => {
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

    return () => {
      unsubscribe()
    }
  }, [isLoggedIn, loadSessions, loadScheduledTasks, loadSkills])

  if (!isLoggedIn) {
    return <Login />
  }

  return (
    <div className="flex h-screen bg-canvas overflow-hidden">
      {/* Top Bar */}
      <TopBar
        rightPanelOpen={rightPanelOpen}
        onToggleRightPanel={() => setRightPanelOpen(prev => !prev)}
      />

      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 pt-12">
        <ChatView rightPanelOpen={rightPanelOpen} />
      </main>

      {/* Permission dialogs */}
      {permissionRequests.map(req => (
        <PermissionDialog key={req.id} request={req} />
      ))}
    </div>
  )
}
