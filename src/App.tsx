import { useEffect } from 'react'
import { useSettingsStore } from './stores/settingsStore'
import { useSessionStore } from './stores/sessionStore'
import Login from './components/Login'
import Sidebar from './components/Sidebar'
import ChatView from './components/Chat'
import PermissionDialog from './components/Dialogs/PermissionDialog'

export default function App() {
  const { isLoggedIn, loadSettings, loadScheduledTasks, permissionRequests } = useSettingsStore()
  const { loadSessions } = useSessionStore()

  useEffect(() => {
    loadSettings()
  }, [])

  useEffect(() => {
    if (isLoggedIn) {
      loadSessions()
      loadScheduledTasks()
    }
  }, [isLoggedIn])

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
