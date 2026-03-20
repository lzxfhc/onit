import { useState } from 'react'
import { Plus, Search, Calendar, MessageSquare, LogOut, Sparkles, Settings, Languages } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useT } from '../../i18n'
import SessionList from './SessionList'
import ActiveTasks from './ActiveTasks'
import ScheduledTasks from './ScheduledTasks'
import HistorySearch from './HistorySearch'
import SkillsPanel from './SkillsPanel'

type SidebarTab = 'sessions' | 'skills' | 'scheduled' | 'search'

export default function Sidebar() {
  const [activeTab, setActiveTab] = useState<SidebarTab>('sessions')
  const [showSettings, setShowSettings] = useState(false)
  const createSession = useSessionStore(state => state.createSession)
  const { logout, setLanguage, settings } = useSettingsStore()
  const t = useT()

  return (
    <aside className="w-72 bg-surface border-r border-border-subtle flex flex-col h-full no-drag relative z-30">
      {/* Header */}
      <div className="pt-14 px-4 pb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-charcoal">{t.sidebar.slogan}</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => createSession()}
            className="btn-icon"
            title={t.sidebar.newSession}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tab Navigation — vertical list */}
      <div className="px-3 flex flex-col gap-0.5 mb-2">
        <TabButton
          active={activeTab === 'sessions'}
          onClick={() => setActiveTab('sessions')}
          icon={<MessageSquare className="w-3.5 h-3.5" />}
          label={t.sidebar.sessions}
        />
        <TabButton
          active={activeTab === 'skills'}
          onClick={() => setActiveTab('skills')}
          icon={<Sparkles className="w-3.5 h-3.5" />}
          label={t.sidebar.skills}
        />
        <TabButton
          active={activeTab === 'scheduled'}
          onClick={() => setActiveTab('scheduled')}
          icon={<Calendar className="w-3.5 h-3.5" />}
          label={t.sidebar.scheduled}
        />
        <TabButton
          active={activeTab === 'search'}
          onClick={() => setActiveTab('search')}
          icon={<Search className="w-3.5 h-3.5" />}
          label={t.sidebar.search}
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
        {activeTab === 'skills' && <SkillsPanel />}
        {activeTab === 'scheduled' && <ScheduledTasks />}
        {activeTab === 'search' && <HistorySearch />}
      </div>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-border-subtle flex items-center gap-1">
        <button
          onClick={logout}
          className="sidebar-item flex-1 text-xs text-text-tertiary hover:text-danger"
        >
          <LogOut className="w-3.5 h-3.5" />
          {t.sidebar.signOut}
        </button>

        {/* Settings button */}
        <div className="relative">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="btn-icon w-7 h-7 text-text-tertiary hover:text-charcoal"
            title={t.sidebar.settings}
          >
            <Settings className="w-3.5 h-3.5" />
          </button>

          {showSettings && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowSettings(false)} />
              <div className="absolute bottom-full right-0 mb-1 bg-surface border border-border-subtle rounded shadow-card-hover py-1 min-w-[160px] z-50 animate-fade-in">
                <div className="px-3 py-1.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
                  {t.sidebar.language}
                </div>
                <button
                  onClick={() => { setLanguage('zh'); setShowSettings(false) }}
                  className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2 ${
                    settings.language === 'zh' ? 'text-accent bg-accent-50' : 'text-text-secondary hover:bg-gray-50'
                  }`}
                >
                  <Languages className="w-3.5 h-3.5" />
                  {t.sidebar.languageZh}
                </button>
                <button
                  onClick={() => { setLanguage('en'); setShowSettings(false) }}
                  className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2 ${
                    settings.language === 'en' ? 'text-accent bg-accent-50' : 'text-text-secondary hover:bg-gray-50'
                  }`}
                >
                  <Languages className="w-3.5 h-3.5" />
                  {t.sidebar.languageEn}
                </button>
              </div>
            </>
          )}
        </div>
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
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-200 ${
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
