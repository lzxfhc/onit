import { useState } from 'react'
import { Plus, Trash2, ToggleLeft, ToggleRight, ChevronDown, Download, Sparkles } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import type { Skill } from '../../types'

type SkillsTab = 'prebuilt' | 'created' | 'imported'

export default function SkillsPanel() {
  const { skills, toggleSkill, deleteSkill, importSkill } = useSettingsStore()
  const { createSession, setActiveSession } = useSessionStore()
  const [activeTab, setActiveTab] = useState<SkillsTab>('prebuilt')
  const [showAddMenu, setShowAddMenu] = useState(false)

  const filteredSkills = skills.filter(s => {
    if (activeTab === 'prebuilt') return s.source === 'prebuilt'
    if (activeTab === 'created') return s.source === 'user-created'
    return s.source === 'imported'
  })

  const handleCreateViaOnit = () => {
    setShowAddMenu(false)
    const session = createSession('Create a New Skill')
    setActiveSession(session.id)
    // Defer to allow React render, then auto-type the prompt
    setTimeout(() => {
      const event = new CustomEvent('onit:auto-input', {
        detail: { text: '@create-skill I want to create a new skill. Please guide me through the process.' },
      })
      window.dispatchEvent(event)
    }, 300)
  }

  const handleImport = async () => {
    setShowAddMenu(false)
    await importSkill()
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 pb-2">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
          Skills
        </span>
        <div className="relative">
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="btn-icon w-6 h-6"
            title="Add Skill"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          {showAddMenu && (
            <div className="absolute right-0 top-full mt-1 bg-surface border border-border-subtle rounded shadow-card-hover py-1 min-w-[180px] z-50 animate-fade-in">
              <button
                onClick={handleCreateViaOnit}
                className="w-full text-left px-3 py-2 text-xs text-text-secondary hover:bg-gray-50 transition-colors flex items-center gap-2"
              >
                <Sparkles className="w-3.5 h-3.5 text-accent" />
                Create with Onit
              </button>
              <button
                onClick={handleImport}
                className="w-full text-left px-3 py-2 text-xs text-text-secondary hover:bg-gray-50 transition-colors flex items-center gap-2"
              >
                <Download className="w-3.5 h-3.5" />
                Import Skill
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-0.5 mx-2 mb-2 p-0.5 bg-gray-100 rounded-md">
        {([
          { id: 'prebuilt' as SkillsTab, label: 'Built-in' },
          { id: 'created' as SkillsTab, label: 'Created' },
          { id: 'imported' as SkillsTab, label: 'Imported' },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-1 text-[10px] font-medium rounded transition-all duration-200 ${
              activeTab === tab.id
                ? 'bg-white text-charcoal shadow-sm'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Skill List */}
      {filteredSkills.length === 0 ? (
        <div className="px-3 py-8 text-center">
          <p className="text-xs text-text-tertiary">
            {activeTab === 'prebuilt'
              ? 'No built-in skills found'
              : activeTab === 'created'
              ? 'No custom skills yet'
              : 'No imported skills'}
          </p>
          {activeTab !== 'prebuilt' && (
            <button
              onClick={activeTab === 'created' ? handleCreateViaOnit : handleImport}
              className="text-xs text-accent hover:underline mt-2"
            >
              {activeTab === 'created' ? 'Create your first skill' : 'Import a skill'}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          {filteredSkills.map(skill => (
            <SkillItem
              key={skill.id}
              skill={skill}
              onToggle={() => toggleSkill(skill.id, !skill.enabled)}
              onDelete={skill.source !== 'prebuilt' ? () => deleteSkill(skill.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SkillItem({ skill, onToggle, onDelete }: {
  skill: Skill
  onToggle: () => void
  onDelete?: () => void
}) {
  const [showDetails, setShowDetails] = useState(false)

  return (
    <div className="card-hover p-3 mx-1">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setShowDetails(!showDetails)}>
          <div className="flex items-center gap-1.5">
            <h4 className="text-sm font-medium text-charcoal truncate">
              {skill.displayName}
            </h4>
            <ChevronDown className={`w-3 h-3 text-text-tertiary transition-transform duration-200 ${showDetails ? 'rotate-180' : ''}`} />
          </div>
          <p className="text-xs text-text-tertiary mt-0.5 line-clamp-2">
            {skill.description}
          </p>
        </div>
        <button
          onClick={onToggle}
          className="shrink-0 mt-0.5"
          title={skill.enabled ? 'Disable' : 'Enable'}
        >
          {skill.enabled ? (
            <ToggleRight className="w-5 h-5 text-accent" />
          ) : (
            <ToggleLeft className="w-5 h-5 text-text-tertiary" />
          )}
        </button>
      </div>

      {showDetails && (
        <div className="mt-2 pt-2 border-t border-border-light animate-fade-in">
          <div className="flex items-center gap-3 text-[10px] text-text-tertiary">
            <span className="font-mono">@{skill.name}</span>
            {skill.version && <span>v{skill.version}</span>}
          </div>
          {onDelete && (
            <button
              onClick={onDelete}
              className="btn-ghost btn-sm text-[10px] text-danger mt-1.5"
            >
              <Trash2 className="w-3 h-3" />
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  )
}
