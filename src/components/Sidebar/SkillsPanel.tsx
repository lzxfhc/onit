import { useState } from 'react'
import { shallow } from 'zustand/shallow'
import {
  Plus, Trash2, ToggleLeft, ToggleRight, ChevronDown, Download,
  Sparkles, Dna, BookOpen, History, Zap,
} from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import type { Skill } from '../../types'
import { useT } from '../../i18n'

type SkillsTab = 'prebuilt' | 'created' | 'imported'

export default function SkillsPanel() {
  const t = useT()
  const { skills, toggleSkill, deleteSkill, importSkill } = useSettingsStore((state) => ({
    skills: state.skills,
    toggleSkill: state.toggleSkill,
    deleteSkill: state.deleteSkill,
    importSkill: state.importSkill,
  }), shallow)
  const { createSession, setActiveSession } = useSessionStore((state) => ({
    createSession: state.createSession,
    setActiveSession: state.setActiveSession,
  }), shallow)
  const [activeTab, setActiveTab] = useState<SkillsTab>('prebuilt')
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [activeDialog, setActiveDialog] = useState<{ type: 'records' | 'evolution'; skillId: string } | null>(null)

  const filteredSkills = skills.filter(s => {
    if (activeTab === 'prebuilt') return s.source === 'prebuilt'
    if (activeTab === 'created') return s.source === 'user-created'
    return s.source === 'imported'
  })

  const handleCreateViaOnit = () => {
    setShowAddMenu(false)
    const session = createSession('Create a New Skill')
    setActiveSession(session.id)
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
          {t.skills.title}
        </span>
        <div className="relative">
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="btn-icon w-6 h-6"
            title={t.skills.addSkill}
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
                {t.skills.createWithOnit}
              </button>
              <button
                onClick={handleImport}
                className="w-full text-left px-3 py-2 text-xs text-text-secondary hover:bg-gray-50 transition-colors flex items-center gap-2"
              >
                <Download className="w-3.5 h-3.5" />
                {t.skills.importSkill}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-0.5 mx-2 mb-2 p-0.5 bg-gray-100 rounded-md">
        {([
          { id: 'prebuilt' as SkillsTab, label: t.skills.builtIn },
          { id: 'created' as SkillsTab, label: t.skills.created },
          { id: 'imported' as SkillsTab, label: t.skills.imported },
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
              ? t.skills.noBuiltIn
              : activeTab === 'created'
              ? t.skills.noCreated
              : t.skills.noImported}
          </p>
          {activeTab !== 'prebuilt' && (
            <button
              onClick={activeTab === 'created' ? handleCreateViaOnit : handleImport}
              className="text-xs text-accent hover:underline mt-2"
            >
              {activeTab === 'created' ? t.skills.createFirst : t.skills.importFirst}
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
              onViewRecords={() => setActiveDialog({ type: 'records', skillId: skill.id })}
              onViewEvolution={() => setActiveDialog({ type: 'evolution', skillId: skill.id })}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      {activeDialog?.type === 'records' && (
        <SkillRecordsDialog
          skillId={activeDialog.skillId}
          onClose={() => setActiveDialog(null)}
          onEvolve={() => setActiveDialog({ type: 'evolution', skillId: activeDialog.skillId })}
        />
      )}
      {activeDialog?.type === 'evolution' && (
        <SkillEvolutionDialog
          skillId={activeDialog.skillId}
          onClose={() => setActiveDialog(null)}
        />
      )}
    </div>
  )
}

function SkillItem({ skill, onToggle, onDelete, onViewRecords, onViewEvolution }: {
  skill: Skill
  onToggle: () => void
  onDelete?: () => void
  onViewRecords: () => void
  onViewEvolution: () => void
}) {
  const t = useT()
  const [showDetails, setShowDetails] = useState(false)
  const { toggleSkillEvolvable } = useSettingsStore((state) => ({
    toggleSkillEvolvable: state.toggleSkillEvolvable,
  }), shallow)

  return (
    <div className="card-hover p-3 mx-1">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setShowDetails(!showDetails)}>
          <div className="flex items-center gap-1.5">
            <h4 className="text-sm font-medium text-charcoal truncate">
              {skill.displayName}
            </h4>
            {skill.version && (
              <span className="text-[9px] text-text-tertiary">v{skill.version}</span>
            )}
            {skill.pendingEvolution && (
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" title={t.skills.updateAvailable} />
            )}
            <ChevronDown className={`w-3 h-3 text-text-tertiary transition-transform duration-200 ${showDetails ? 'rotate-180' : ''}`} />
          </div>
          <p className="text-xs text-text-tertiary mt-0.5 line-clamp-2">
            {skill.description}
          </p>
          {/* Evolution indicators */}
          {skill.evolvable && (skill.recordCount > 0 || skill.usageCount > 0) && (
            <div className="flex items-center gap-2 mt-1">
              <span className="inline-flex items-center gap-0.5 text-[9px] text-text-tertiary">
                <Dna className="w-2.5 h-2.5" />
                {skill.recordCount} {t.skills.records}
              </span>
              <span className="text-[9px] text-text-tertiary">
                {t.skills.used} {skill.usageCount}{t.skills.times}
              </span>
            </div>
          )}
        </div>
        <button
          onClick={onToggle}
          className="shrink-0 mt-0.5"
          title={skill.enabled ? t.scheduled.disable : t.scheduled.enable}
        >
          {skill.enabled ? (
            <ToggleRight className="w-5 h-5 text-accent" />
          ) : (
            <ToggleLeft className="w-5 h-5 text-text-tertiary" />
          )}
        </button>
      </div>

      {/* Pending evolution badge — auto-populated by background analysis */}
      {skill.pendingEvolution && (
        <button
          onClick={onViewEvolution}
          className="mt-2 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-accent-50 text-accent-700 text-[10px] font-medium hover:bg-accent/10 transition-colors"
        >
          <Zap className="w-3 h-3" />
          {t.skills.improvementsFound}
        </button>
      )}

      {showDetails && (
        <div className="mt-2 pt-2 border-t border-border-light animate-fade-in">
          <div className="flex items-center gap-3 text-[10px] text-text-tertiary">
            <span className="font-mono">@{skill.name}</span>
          </div>

          {/* Evolution toggle */}
          <div className="flex items-center justify-between mt-2">
            <label className="flex items-center gap-1.5 text-[10px] text-text-secondary cursor-pointer">
              <Dna className="w-3 h-3" />
              {t.skills.enableEvolution}
            </label>
            <button
              onClick={() => toggleSkillEvolvable(skill.id, !skill.evolvable)}
              className="shrink-0"
            >
              {skill.evolvable ? (
                <ToggleRight className="w-4 h-4 text-accent" />
              ) : (
                <ToggleLeft className="w-4 h-4 text-text-tertiary" />
              )}
            </button>
          </div>

          {/* Evolution actions */}
          {skill.evolvable && (
            <div className="flex items-center gap-1.5 mt-2">
              <button
                onClick={onViewRecords}
                className="btn-ghost btn-sm text-[10px]"
              >
                <BookOpen className="w-3 h-3" />
                {t.skills.viewRecords}
              </button>
              <button
                onClick={onViewEvolution}
                className="btn-ghost btn-sm text-[10px]"
              >
                <History className="w-3 h-3" />
                {t.skills.evolve}
              </button>
            </div>
          )}

          {onDelete && (
            <button
              onClick={onDelete}
              className="btn-ghost btn-sm text-[10px] text-danger mt-1.5"
            >
              <Trash2 className="w-3 h-3" />
              {t.skills.delete}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline Dialogs
// ---------------------------------------------------------------------------

function SkillRecordsDialog({ skillId, onClose, onEvolve }: {
  skillId: string
  onClose: () => void
  onEvolve: () => void
}) {
  const { getSkillEvolution, deleteSkillRecord, skills } = useSettingsStore((state) => ({
    getSkillEvolution: state.getSkillEvolution,
    deleteSkillRecord: state.deleteSkillRecord,
    skills: state.skills,
  }), shallow)

  const t = useT()
  const skill = skills.find(s => s.id === skillId)
  const [records, setRecords] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useState(() => {
    getSkillEvolution(skillId).then(data => {
      setRecords(data.records || [])
      setLoading(false)
    })
  })

  const handleDelete = async (recordId: string) => {
    await deleteSkillRecord(skillId, recordId)
    setRecords(prev => prev.filter(r => r.id !== recordId))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={onClose}>
      <div
        className="bg-surface rounded-lg shadow-card-hover border border-border-subtle w-[420px] max-h-[80vh] flex flex-col animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <div>
            <h3 className="text-sm font-semibold text-charcoal">{t.skills.usageRecords}</h3>
            <p className="text-[10px] text-text-tertiary mt-0.5">{skill?.displayName}</p>
          </div>
          <button onClick={onClose} className="btn-icon w-6 h-6">
            <ChevronDown className="w-3.5 h-3.5 rotate-90" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <p className="text-xs text-text-tertiary text-center py-6">{t.skills.loading}</p>
          ) : records.length === 0 ? (
            <p className="text-xs text-text-tertiary text-center py-6">
              {t.skills.noRecords}
            </p>
          ) : (
            <div className="space-y-3">
              {records.map(record => (
                <div key={record.id} className="p-2.5 rounded-md border border-border-light">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] text-text-tertiary">
                        {new Date(record.timestamp).toLocaleDateString()}
                        {record.context?.iterationCount ? ` · ${record.context.iterationCount} ${t.skills.iterations}` : ''}
                        {record.compressed ? ` · ${t.skills.compressed}` : ''}
                      </p>
                      {/* Show conversation preview */}
                      {record.conversation && (
                        <p className="text-xs text-charcoal mt-1 line-clamp-2 leading-relaxed">
                          {record.conversation.substring(0, 150)}
                          {record.conversation.length > 150 ? '...' : ''}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(record.id)}
                      className="text-[9px] text-danger hover:underline shrink-0"
                    >
                      {t.skills.remove}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {records.length > 0 && (
          <div className="px-4 py-3 border-t border-border-subtle">
            <button
              onClick={onEvolve}
              className="w-full btn-primary text-xs py-2"
            >
              <Zap className="w-3.5 h-3.5" />
              {t.skills.evolveNow}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function SkillEvolutionDialog({ skillId, onClose }: {
  skillId: string
  onClose: () => void
}) {
  const { getSkillEvolution, evolveSkill, applySkillEvolution, rejectSkillEvolution, rollbackSkill, skills, loadSkills } = useSettingsStore((state) => ({
    getSkillEvolution: state.getSkillEvolution,
    evolveSkill: state.evolveSkill,
    applySkillEvolution: state.applySkillEvolution,
    rejectSkillEvolution: state.rejectSkillEvolution,
    rollbackSkill: state.rollbackSkill,
    skills: state.skills,
    loadSkills: state.loadSkills,
  }), shallow)

  const t = useT()
  const skill = skills.find(s => s.id === skillId)
  const [evoData, setEvoData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [synthesizing, setSynthesizing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<'pending' | 'history'>('pending')

  useState(() => {
    getSkillEvolution(skillId).then(data => {
      setEvoData(data)
      setLoading(false)
      if (data.pendingEvolution) {
        setActiveView('pending')
      } else if (data.history?.length > 0) {
        setActiveView('history')
      }
    })
  })

  const handleSynthesize = async () => {
    setSynthesizing(true)
    setError(null)
    const result = await evolveSkill(skillId)
    if (result.success) {
      const data = await getSkillEvolution(skillId)
      setEvoData(data)
      setActiveView('pending')
    } else {
      setError(result.error || 'Evolution failed')
    }
    setSynthesizing(false)
  }

  const handleApply = async () => {
    const success = await applySkillEvolution(skillId)
    if (success) {
      await loadSkills()
      const data = await getSkillEvolution(skillId)
      setEvoData(data)
      setActiveView('history')
    }
  }

  const handleReject = async () => {
    await rejectSkillEvolution(skillId)
    const data = await getSkillEvolution(skillId)
    setEvoData(data)
  }

  const handleRollback = async (version: string) => {
    const success = await rollbackSkill(skillId, version)
    if (success) {
      await loadSkills()
      const data = await getSkillEvolution(skillId)
      setEvoData(data)
    }
  }

  const pending = evoData?.pendingEvolution
  const history = evoData?.history || []
  const recordCount = evoData?.records?.length || 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={onClose}>
      <div
        className="bg-surface rounded-lg shadow-card-hover border border-border-subtle w-[560px] max-h-[85vh] flex flex-col animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <div>
            <h3 className="text-sm font-semibold text-charcoal">{t.skills.skillEvolution}</h3>
            <p className="text-[10px] text-text-tertiary mt-0.5">{skill?.displayName}</p>
          </div>
          <button onClick={onClose} className="btn-icon w-6 h-6">
            <ChevronDown className="w-3.5 h-3.5 rotate-90" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-0.5 mx-4 mt-3 p-0.5 bg-gray-100 rounded-md">
          <button
            onClick={() => setActiveView('pending')}
            className={`flex-1 py-1 text-[10px] font-medium rounded transition-all ${
              activeView === 'pending' ? 'bg-white text-charcoal shadow-sm' : 'text-text-tertiary'
            }`}
          >
            {t.skills.proposedUpdate} {pending ? '(1)' : ''}
          </button>
          <button
            onClick={() => setActiveView('history')}
            className={`flex-1 py-1 text-[10px] font-medium rounded transition-all ${
              activeView === 'history' ? 'bg-white text-charcoal shadow-sm' : 'text-text-tertiary'
            }`}
          >
            {t.skills.history} ({history.length})
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <p className="text-xs text-text-tertiary text-center py-6">{t.skills.loading}</p>
          ) : activeView === 'pending' ? (
            pending ? (
              <div>
                {/* Summary */}
                <div className="p-3 rounded-md bg-accent-50 border border-accent/20 mb-3">
                  <p className="text-xs text-charcoal leading-relaxed">{pending.summary}</p>
                </div>

                {/* Proposed memory */}
                <p className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mb-1.5">
                  {t.skills.proposedMemory}
                </p>

                <div className="p-3 rounded bg-gray-50 text-[10px] text-text-secondary leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {pending.proposedMemory}
                </div>

                {/* Records used */}
                <p className="text-[9px] text-text-tertiary mt-2">
                  {t.skills.basedOn} {pending.recordsUsed?.length || 0} {t.skills.usageRecordsCount}
                </p>

                {error && (
                  <p className="text-xs text-danger mt-2">{error}</p>
                )}
              </div>
            ) : (
              <div className="text-center py-6">
                <Dna className="w-8 h-8 text-text-tertiary mx-auto mb-2" />
                <p className="text-xs text-text-tertiary mb-3">
                  {recordCount > 0
                    ? `${recordCount} ${t.skills.usageRecordsCount}`
                    : t.skills.noRecordsYet}
                </p>
                {recordCount > 0 && (
                  <button
                    onClick={handleSynthesize}
                    disabled={synthesizing}
                    className="btn-primary text-xs px-4 py-2 disabled:opacity-50"
                  >
                    {synthesizing ? t.skills.analyzing : t.skills.evolveNow}
                  </button>
                )}
                {error && (
                  <p className="text-xs text-danger mt-2">{error}</p>
                )}
              </div>
            )
          ) : (
            /* History view */
            history.length === 0 ? (
              <p className="text-xs text-text-tertiary text-center py-6">{t.skills.noHistory}</p>
            ) : (
              <div className="space-y-2">
                {[...history].reverse().map((entry: any) => (
                  <div key={entry.timestamp} className="p-2.5 rounded-md border border-border-light">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-charcoal">
                        {new Date(entry.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-[10px] text-text-secondary mt-1 leading-relaxed">{entry.summary}</p>
                    {entry.memorySnapshot && (
                      <details className="mt-1.5">
                        <summary className="text-[9px] text-accent cursor-pointer hover:underline">
                          {t.skills.viewSnapshot}
                        </summary>
                        <div className="mt-1 p-2 rounded bg-gray-50 text-[9px] text-text-tertiary whitespace-pre-wrap max-h-32 overflow-y-auto">
                          {entry.memorySnapshot}
                        </div>
                      </details>
                    )}
                    <button
                      onClick={() => handleRollback(String(entry.timestamp))}
                      className="text-[9px] text-accent hover:underline mt-1.5"
                    >
                      {t.skills.rollback}
                    </button>
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        {/* Actions for pending evolution */}
        {pending && activeView === 'pending' && (
          <div className="flex items-center gap-2 px-4 py-3 border-t border-border-subtle">
            <button
              onClick={handleApply}
              className="btn-primary flex-1 text-xs py-2"
            >
              {t.skills.applyUpdate}
            </button>
            <button
              onClick={handleReject}
              className="btn-ghost flex-1 text-xs py-2 text-danger"
            >
              {t.skills.reject}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
