import { useEffect } from 'react'
import { shallow } from 'zustand/shallow'
import { useSettingsStore } from './stores/settingsStore'
import { useSessionStore } from './stores/sessionStore'
import Login from './components/Login'
import Sidebar from './components/Sidebar'
import ChatView from './components/Chat'
import PermissionDialog from './components/Dialogs/PermissionDialog'
import type { Session } from './types'

export default function App() {
  const { isLoggedIn, loadSettings, loadScheduledTasks, loadSkills, permissionRequests } = useSettingsStore((state) => ({
    isLoggedIn: state.isLoggedIn,
    loadSettings: state.loadSettings,
    loadScheduledTasks: state.loadScheduledTasks,
    loadSkills: state.loadSkills,
    permissionRequests: state.permissionRequests,
  }), shallow)
  const { loadSessions, registerExternalSession, saveSession } = useSessionStore((state) => ({
    loadSessions: state.loadSessions,
    registerExternalSession: state.registerExternalSession,
    saveSession: state.saveSession,
  }), shallow)

  useEffect(() => {
    loadSettings()
  }, [])

  useEffect(() => {
    if (!isLoggedIn) return

    loadSessions()
    loadScheduledTasks()
    loadSkills()

    const unsubscribe = window.electronAPI.onSchedulerSessionCreated((data: any) => {
      const session: Session = {
        id: data.sessionId,
        name: data.taskName,
        messages: [],
        status: 'running',
        activeRunId: data.runId,
        permissionMode: 'full-access',
        workspacePath: data.workspacePath || null,
        attachedFiles: [],
        model: data.model || 'qianfan-code-latest',
        tasks: [],
        workspaceFiles: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isBackgroundRunning: true,
        backgroundCompleted: false,
        hasUnviewedResult: false,
      }

      registerExternalSession(session)
      saveSession(session.id)
    })

    return () => {
      unsubscribe()
    }
  }, [isLoggedIn, loadSessions, loadScheduledTasks, loadSkills, registerExternalSession, saveSession])

  if (!isLoggedIn) {
    return <Login />
  }

  return (
    <div className="flex h-screen bg-canvas overflow-hidden">
      {/* Title bar drag area */}
      <div className="fixed top-0 left-0 right-0 h-12 drag-region z-40" />

      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        <ChatView />
      </main>

      {/* Permission dialogs */}
      {permissionRequests.map(req => (
        <PermissionDialog key={req.id} request={req} />
      ))}
    </div>
  )
}
