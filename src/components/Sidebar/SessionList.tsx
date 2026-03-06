import { MessageSquare, Trash2, MoreHorizontal } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useState, useRef, useEffect } from 'react'

export default function SessionList() {
  const { sessions, activeSessionId, setActiveSession, deleteSession, markSessionViewed } = useSessionStore()

  const nonActiveSessions = sessions.filter(s =>
    !(s.isBackgroundRunning || s.hasUnviewedResult)
  )

  const handleSessionClick = (id: string) => {
    setActiveSession(id)
    const session = sessions.find(s => s.id === id)
    if (session?.hasUnviewedResult) {
      markSessionViewed(id)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 pb-2">
      <div className="px-2 py-1.5">
        <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
          Sessions
        </span>
      </div>
      <div className="space-y-0.5">
        {nonActiveSessions.map(session => (
          <SessionItem
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onClick={() => handleSessionClick(session.id)}
            onDelete={() => deleteSession(session.id)}
          />
        ))}
      </div>
    </div>
  )
}

function SessionItem({ session, isActive, onClick, onDelete }: {
  session: any
  isActive: boolean
  onClick: () => void
  onDelete: () => void
}) {
  const [showMenu, setShowMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
      }
    }
    if (showMenu) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showMenu])

  const getStatusIndicator = () => {
    if (session.status === 'running' && !session.isBackgroundRunning) {
      return <div className="status-running" />
    }
    if (session.status === 'error') {
      return <div className="status-error" />
    }
    return null
  }

  const getSessionPreview = () => {
    if (session.messages.length === 0) return 'New session'
    const lastUserMsg = [...session.messages].reverse().find((m: any) => m.role === 'user')
    return lastUserMsg ? lastUserMsg.content.substring(0, 50) : 'Session'
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  return (
    <div
      onClick={onClick}
      className={`group relative flex items-start gap-2.5 px-3 py-2.5 rounded-md cursor-pointer transition-all duration-200 ${
        isActive
          ? 'bg-accent-50 text-accent-700'
          : 'text-text-secondary hover:bg-gray-50 hover:text-charcoal'
      }`}
    >
      <MessageSquare className="w-4 h-4 mt-0.5 shrink-0 opacity-50" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate flex-1">
            {session.name}
          </span>
          {getStatusIndicator()}
        </div>
        <p className="text-xs text-text-tertiary truncate mt-0.5">
          {getSessionPreview()}
        </p>
      </div>
      <span className="text-[10px] text-text-tertiary shrink-0 mt-0.5">
        {formatTime(session.updatedAt)}
      </span>

      {/* Menu trigger */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu) }}
          className={`btn-icon w-6 h-6 opacity-0 group-hover:opacity-100 transition-opacity ${showMenu ? 'opacity-100' : ''}`}
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
        {showMenu && (
          <div className="absolute right-0 top-7 bg-surface border border-border-subtle rounded-md shadow-card-hover py-1 min-w-[120px] z-50 animate-fade-in">
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); setShowMenu(false) }}
              className="flex items-center gap-2 px-3 py-1.5 text-xs text-danger hover:bg-danger-light w-full text-left transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
