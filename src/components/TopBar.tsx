import { PanelRight, PanelRightClose } from 'lucide-react'
import { shallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { isWindows } from '../utils/platform'

interface Props {
  rightPanelOpen: boolean
  onToggleRightPanel: () => void
}

export default function TopBar({ rightPanelOpen, onToggleRightPanel }: Props) {
  const activeSession = useSessionStore(state => {
    const session = state.sessions.find(s => s.id === state.activeSessionId)
    return {
      exists: !!session,
      name: session?.name || '',
      hasMessages: (session?.messages.length || 0) > 0,
    }
  }, shallow)

  const showName = activeSession.exists && activeSession.hasMessages && activeSession.name
  const showToggle = activeSession.exists

  return (
    <div className="fixed top-0 left-0 right-0 h-12 z-40 flex items-stretch drag-region">
      {/* Left section: aligns with sidebar */}
      <div className="w-72 shrink-0 bg-surface border-r border-border-subtle" />

      {/* Middle section: chat area header */}
      <div className="flex-1 flex items-center px-4 bg-canvas border-b border-border-subtle min-w-0">
        {showName && (
          <span className="text-xs font-medium text-text-secondary truncate max-w-[300px] no-drag select-none">
            {activeSession.name}
          </span>
        )}

        <div className="flex-1" />
      </div>

      {/* Right section: always rendered when session exists, button stays in fixed position */}
      {showToggle && (
        <div className={`w-72 shrink-0 flex items-center justify-end px-3 bg-canvas border-b border-border-subtle ${
          isWindows ? 'pr-[140px]' : ''
        }`}>
          <button
            onClick={onToggleRightPanel}
            className="btn-icon no-drag"
            title={rightPanelOpen ? 'Hide panel' : 'Show panel'}
          >
            {rightPanelOpen ? (
              <PanelRightClose className="w-4 h-4" />
            ) : (
              <PanelRight className="w-4 h-4" />
            )}
          </button>
        </div>
      )}

      {/* Windows: fallback right padding when no session (for titleBarOverlay buttons) */}
      {!showToggle && isWindows && (
        <div className="w-[140px] shrink-0 bg-canvas border-b border-border-subtle" />
      )}
    </div>
  )
}
