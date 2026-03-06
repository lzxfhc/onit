import { useState } from 'react'
import { Plus, Search, Clock, Calendar, MessageSquare, LogOut } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import SessionList from './SessionList'
import ActiveTasks from './ActiveTasks'
import ScheduledTasks from './ScheduledTasks'
import HistorySearch from './HistorySearch'

type SidebarTab = 'sessions' | 'scheduled' | 'search'

export default function Sidebar() {
  const [activeTab, setActiveTab] = useState<SidebarTab>('sessions')
  const { createSession } = useSessionStore()
  const { logout } = useSettingsStore()

  return (
    <aside className="w-72 bg-surface border-r border-border-subtle flex flex-col h-full no-drag relative z-30">
      {/* Header */}
      <div className="pt-14 px-4 pb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-charcoal">You say it. Onit.</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => createSession()}
            className="btn-icon"
            title="New Session"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="px-3 flex gap-1 mb-2">
        <TabButton
          active={activeTab === 'sessions'}
          onClick={() => setActiveTab('sessions')}
          icon={<MessageSquare className="w-3.5 h-3.5" />}
          label="Sessions"
        />
        <TabButton
          active={activeTab === 'scheduled'}
          onClick={() => setActiveTab('scheduled')}
          icon={<Calendar className="w-3.5 h-3.5" />}
          label="Scheduled"
        />
        <TabButton
          active={activeTab === 'search'}
          onClick={() => setActiveTab('search')}
          icon={<Search className="w-3.5 h-3.5" />}
          label="Search"
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'sessions' && (
          <>
            <ActiveTasks />
            <SessionList />
          </>
        )}
        {activeTab === 'scheduled' && <ScheduledTasks />}
        {activeTab === 'search' && <HistorySearch />}
      </div>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-border-subtle">
        <button
          onClick={logout}
          className="sidebar-item w-full text-xs text-text-tertiary hover:text-danger"
        >
          <LogOut className="w-3.5 h-3.5" />
          Sign Out
        </button>
      </div>
    </aside>
  )
}

function TabButton({ active, onClick, icon, label }: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-all duration-200 ${
        active
          ? 'bg-accent-50 text-accent-700'
          : 'text-text-secondary hover:bg-gray-50 hover:text-charcoal'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
