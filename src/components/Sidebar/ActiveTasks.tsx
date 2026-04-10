import { Loader2, CheckCircle2, Eye } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useT } from '../../i18n'

export default function ActiveTasks() {
  const t = useT()
  const { sessions, activeSessionId, setActiveSession, markSessionViewed } = useSessionStore()

  const activeTasks = sessions.filter(s =>
    s.isBackgroundRunning || s.hasUnviewedResult
  )

  if (activeTasks.length === 0) return null

  const handleClick = (id: string) => {
    setActiveSession(id)
    const session = sessions.find(s => s.id === id)
    if (session?.hasUnviewedResult) {
      markSessionViewed(id)
    }
  }

  return (
    <div className="px-2 mb-2">
      <div className="px-2 py-1.5">
        <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
          {t.sessions.activeTasks}
        </span>
      </div>
      <div className="space-y-0.5">
        {activeTasks.map(session => (
          <div
            key={session.id}
            onClick={() => handleClick(session.id)}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-md cursor-pointer transition-all duration-200 ${
              session.id === activeSessionId
                ? 'bg-accent-50 text-accent-700'
                : 'hover:bg-gray-50 text-text-secondary'
            }`}
          >
            {session.isBackgroundRunning ? (
              <Loader2 className="w-4 h-4 animate-spin text-accent shrink-0" />
            ) : session.hasUnviewedResult ? (
              <div className="relative shrink-0">
                <CheckCircle2 className="w-4 h-4 text-success" />
                <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-warning rounded-full animate-pulse-dot" />
              </div>
            ) : null}
            <span className="text-sm truncate flex-1">{session.name}</span>
            {session.hasUnviewedResult && (
              <Eye className="w-3.5 h-3.5 text-text-tertiary" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
