import { PanelRight, PanelRightClose } from 'lucide-react'
import { shallow } from 'zustand/shallow'
import { useT } from '../i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useCopilotStore } from '../stores/copilotStore'
import { isWindows } from '../utils/platform'
import type { AppMode } from '../types'

interface Props {
  rightPanelOpen: boolean
  onToggleRightPanel: () => void
}

export default function TopBar({ rightPanelOpen, onToggleRightPanel }: Props) {
  const t = useT()
  const appMode = useCopilotStore(s => s.appMode)
  const setAppMode = useCopilotStore(s => s.setAppMode)
  const isCopilot = appMode === 'copilot'

  const activeSession = useSessionStore(state => {
    const session = state.sessions.find(s => s.id === state.activeSessionId)
    return {
      exists: !!session,
      name: session?.name || '',
      hasMessages: (session?.messages.length || 0) > 0,
    }
  }, shallow)

  const showName = !isCopilot && activeSession.exists && activeSession.hasMessages && activeSession.name
  const showToggle = !isCopilot && activeSession.exists

  return (
    <div className="fixed top-0 left-0 right-0 h-12 z-40 flex items-stretch drag-region">
      {/* Left section: aligns with sidebar (only in onit mode) */}
      {!isCopilot && (
        <div className="w-72 shrink-0 bg-surface border-r border-border-subtle" />
      )}

      {/* Middle section: tab switcher + session name */}
      <div className="flex-1 flex items-center px-4 bg-canvas border-b border-border-subtle min-w-0">
        {/* Left area: session name in onit mode */}
        {showName && (
          <span className="text-xs font-medium text-text-secondary truncate max-w-[300px] no-drag select-none">
            {activeSession.name}
          </span>
        )}

        <div className="flex-1" />

        {/* Center: Mode tab switcher */}
        <div className="flex items-center gap-1 no-drag select-none">
          <TabButton
            label={t.copilot.tabOnit}
            active={appMode === 'onit'}
            onClick={() => setAppMode('onit')}
          />
          <TabButton
            label={t.copilot.tabCopilot}
            active={appMode === 'copilot'}
            onClick={() => setAppMode('copilot')}
          />
        </div>

        <div className="flex-1" />
      </div>

      {/* Right section: panel toggle (onit mode only) */}
      {showToggle && (
        <div className={`w-72 shrink-0 flex items-center justify-end px-3 bg-canvas border-b border-border-subtle ${
          isWindows ? 'pr-[140px]' : ''
        }`}>
          <button
            onClick={onToggleRightPanel}
            className="btn-icon no-drag"
            title={rightPanelOpen ? t.topBar.hidePanel : t.topBar.showPanel}
          >
            {rightPanelOpen ? (
              <PanelRightClose className="w-4 h-4" />
            ) : (
              <PanelRight className="w-4 h-4" />
            )}
          </button>
        </div>
      )}

      {/* Windows: fallback right padding when no toggle button (for titleBarOverlay buttons) */}
      {!showToggle && isWindows && (
        <div className="w-[140px] shrink-0 bg-canvas border-b border-border-subtle" />
      )}
    </div>
  )
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-xs font-medium rounded-full transition-all duration-200 ${
        active
          ? 'bg-accent text-white'
          : 'text-text-secondary hover:text-charcoal hover:bg-gray-100'
      }`}
    >
      {label}
    </button>
  )
}
