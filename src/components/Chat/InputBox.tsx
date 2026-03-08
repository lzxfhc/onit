import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Send, Square, FolderOpen, Paperclip, ChevronDown,
  X, FileText, Shield, ShieldCheck, ShieldOff,
  Loader2, CheckCircle2, Sparkles
} from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { AVAILABLE_MODELS } from '../../types'
import type { PermissionMode, Session, Skill } from '../../types'

interface Props {
  onSend: (content: string) => void
  onStop: () => void
  isRunning: boolean
  session: Session
}

export default function InputBox({ onSend, onStop, isRunning, session }: Props) {
  const [input, setInput] = useState('')
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [showPermissionPicker, setShowPermissionPicker] = useState(false)
  const [showSkillMention, setShowSkillMention] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const isComposingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const permPickerRef = useRef<HTMLDivElement>(null)
  const mentionRef = useRef<HTMLDivElement>(null)
  const {
    setWorkspace, setPermissionMode, setModel,
    addAttachedFile, removeAttachedFile,
  } = useSessionStore()
  const { settings, skills } = useSettingsStore()

  const enabledSkills = skills.filter(s => s.enabled)

  const filteredMentionSkills = enabledSkills.filter(s =>
    !mentionFilter || s.name.includes(mentionFilter) || s.displayName.toLowerCase().includes(mentionFilter.toLowerCase())
  )

  // Auto resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
    }
  }, [input])

  // Close pickers on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false)
      }
      if (permPickerRef.current && !permPickerRef.current.contains(e.target as Node)) {
        setShowPermissionPicker(false)
      }
      if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) {
        setShowSkillMention(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Listen for auto-input events (from SkillsPanel "Create with Onit")
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (e.detail?.text) {
        setInput(e.detail.text)
        setTimeout(() => textareaRef.current?.focus(), 100)
      }
    }
    window.addEventListener('onit:auto-input', handler as EventListener)
    return () => window.removeEventListener('onit:auto-input', handler as EventListener)
  }, [])

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInput(value)

    // @mention only triggers when @ is at the very start of input (position 0)
    if (value.startsWith('@')) {
      // Extract the text after @ up to the first space (or end of string)
      const afterAt = value.substring(1)
      const spaceIdx = afterAt.indexOf(' ')
      // If there's a space, @ selection is already completed — don't show popup
      if (spaceIdx >= 0) {
        setShowSkillMention(false)
        return
      }
      // Show mention popup with filter
      setMentionFilter(afterAt)
      setShowSkillMention(true)
      setMentionIndex(0)
      return
    }

    setShowSkillMention(false)
  }

  const insertMention = useCallback((skill: Skill) => {
    // Replace entire @... prefix with @skill-name
    const afterAt = input.substring(1)
    const spaceIdx = afterAt.indexOf(' ')
    const rest = spaceIdx >= 0 ? afterAt.substring(spaceIdx) : ''
    const newValue = `@${skill.name} ${rest.trimStart()}`
    setInput(newValue)
    setShowSkillMention(false)
    textareaRef.current?.focus()
  }, [input])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ignore key events during IME composition (e.g. Chinese/Japanese input)
    if (isComposingRef.current) return

    // Handle mention navigation
    if (showSkillMention && filteredMentionSkills.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex(prev => Math.min(prev + 1, filteredMentionSkills.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex(prev => Math.max(prev - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(filteredMentionSkills[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        setShowSkillMention(false)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSend = () => {
    if (isRunning) {
      onStop()
      setTimeout(() => {
        if (input.trim()) {
          onSend(input.trim())
          setInput('')
        }
      }, 200)
      return
    }
    if (!input.trim()) return
    onSend(input.trim())
    setInput('')
  }

  const handleSelectFolder = async () => {
    const folder = await window.electronAPI.selectFolder()
    if (folder) setWorkspace(session.id, folder)
  }

  const handleSelectFiles = async () => {
    const files = await window.electronAPI.selectFiles()
    for (const f of files) {
      addAttachedFile(session.id, f)
    }
  }

  const getModelName = () => {
    const m = AVAILABLE_MODELS.find(m => m.id === session.model)
    return m ? m.name : session.model
  }

  const permissionModes: { id: PermissionMode; label: string; desc: string; icon: React.ReactNode }[] = [
    { id: 'plan', label: 'Plan Mode', desc: 'Confirm all operations', icon: <Shield className="w-3.5 h-3.5" /> },
    { id: 'accept-edit', label: 'AcceptEdit', desc: 'Smart confirmations', icon: <ShieldCheck className="w-3.5 h-3.5" /> },
    { id: 'full-access', label: 'Full Access', desc: 'Auto-execute all', icon: <ShieldOff className="w-3.5 h-3.5" /> },
  ]

  const currentPerm = permissionModes.find(p => p.id === session.permissionMode) || permissionModes[1]

  return (
    <div className="border-t border-border-subtle bg-surface px-4 py-3">
      <div className="max-w-3xl mx-auto">
        {/* Attached files */}
        {session.attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {session.attachedFiles.map(f => (
              <span key={f} className="inline-flex items-center gap-1 px-2 py-1 bg-gray-50 border border-border-subtle rounded text-[10px] text-text-secondary">
                <FileText className="w-3 h-3" />
                {f.split('/').pop()}
                <button
                  onClick={() => removeAttachedFile(session.id, f)}
                  className="hover:text-danger transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Input area */}
        <div className="flex items-end gap-2">
          <div className="flex-1 relative bg-canvas border border-border-subtle rounded-lg focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10 transition-all">
            {/* Skill mention dropdown — appears above textarea near cursor */}
            {showSkillMention && filteredMentionSkills.length > 0 && (
              <div
                ref={mentionRef}
                className="absolute bottom-full left-0 mb-1 bg-surface border border-border-subtle rounded-lg shadow-card-hover py-1 min-w-[240px] max-w-[320px] z-50 animate-fade-in"
              >
                <div className="px-3 py-1.5 border-b border-border-light">
                  <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Skills</span>
                </div>
                <div className="max-h-[200px] overflow-y-auto py-0.5">
                  {filteredMentionSkills.map((skill, idx) => (
                    <button
                      key={skill.id}
                      onClick={() => insertMention(skill)}
                      className={`w-full text-left px-3 py-2 transition-colors ${
                        idx === mentionIndex
                          ? 'bg-accent-50'
                          : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-3 h-3 text-accent shrink-0" />
                        <span className="text-xs font-medium text-charcoal truncate">{skill.displayName}</span>
                      </div>
                      <p className="text-[10px] text-text-tertiary mt-0.5 ml-5 truncate">{skill.description}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { isComposingRef.current = true }}
              onCompositionEnd={() => { isComposingRef.current = false }}
              placeholder={isRunning ? 'Type to interrupt and send new instruction...' : 'Ask me anything... (@ at start to invoke skills)'}
              className="w-full resize-none bg-transparent px-4 py-3 text-sm text-charcoal placeholder:text-text-tertiary focus:outline-none"
              rows={1}
              style={{ minHeight: '44px', maxHeight: '200px' }}
            />

            {/* Toolbar inside textarea */}
            <div className="flex items-center gap-1 px-2 pb-2">
              {/* Workspace */}
              <button
                onClick={handleSelectFolder}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-all ${
                  session.workspacePath
                    ? 'bg-accent-50 text-accent-700'
                    : 'text-text-tertiary hover:bg-gray-100 hover:text-text-secondary'
                }`}
                title={session.workspacePath || 'Select workspace folder'}
              >
                <FolderOpen className="w-3 h-3" />
                {session.workspacePath
                  ? session.workspacePath.split('/').pop()
                  : 'Workspace'}
              </button>

              {/* Attach files */}
              <button
                onClick={handleSelectFiles}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-text-tertiary hover:bg-gray-100 hover:text-text-secondary transition-all"
                title="Attach files"
              >
                <Paperclip className="w-3 h-3" />
                Attach
              </button>

              {/* Model selector */}
              <div className="relative ml-auto" ref={modelPickerRef}>
                <button
                  onClick={() => setShowModelPicker(!showModelPicker)}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-text-tertiary hover:bg-gray-100 hover:text-text-secondary transition-all"
                >
                  {getModelName()}
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showModelPicker && (
                  <div className="absolute bottom-full right-0 mb-1 bg-surface border border-border-subtle rounded shadow-card-hover py-1 min-w-[180px] z-50 animate-fade-in">
                    {AVAILABLE_MODELS
                      .filter(m => settings.apiConfig.billingMode === 'coding-plan' ? m.codingPlan : !m.codingPlan)
                      .map(m => (
                      <button
                        key={m.id}
                        onClick={() => { setModel(session.id, m.id); setShowModelPicker(false) }}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                          session.model === m.id
                            ? 'bg-accent-50 text-accent-700'
                            : 'text-text-secondary hover:bg-gray-50'
                        }`}
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Permission mode */}
              <div className="relative" ref={permPickerRef}>
                <button
                  onClick={() => setShowPermissionPicker(!showPermissionPicker)}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-all ${
                    session.permissionMode === 'full-access'
                      ? 'text-warning hover:bg-warning-light'
                      : session.permissionMode === 'plan'
                      ? 'text-success hover:bg-success-light'
                      : 'text-text-tertiary hover:bg-gray-100'
                  }`}
                >
                  {currentPerm.icon}
                  {currentPerm.label}
                </button>
                {showPermissionPicker && (
                  <div className="absolute bottom-full right-0 mb-1 bg-surface border border-border-subtle rounded shadow-card-hover py-1 min-w-[200px] z-50 animate-fade-in">
                    {permissionModes.map(pm => (
                      <button
                        key={pm.id}
                        onClick={() => {
                          setPermissionMode(session.id, pm.id)
                          setShowPermissionPicker(false)
                        }}
                        className={`w-full text-left px-3 py-2 transition-colors ${
                          session.permissionMode === pm.id
                            ? 'bg-accent-50'
                            : 'hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {pm.icon}
                          <span className="text-xs font-medium text-charcoal">{pm.label}</span>
                        </div>
                        <p className="text-[10px] text-text-tertiary mt-0.5 ml-5.5">{pm.desc}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Send/Stop button */}
          <button
            onClick={isRunning ? onStop : handleSend}
            disabled={!isRunning && !input.trim()}
            className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
              isRunning
                ? 'bg-danger text-white hover:bg-red-600'
                : input.trim()
                ? 'bg-accent text-white hover:bg-accent-hover'
                : 'bg-gray-100 text-text-tertiary cursor-not-allowed'
            }`}
          >
            {isRunning ? (
              <Square className="w-4 h-4" fill="currentColor" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Active Background Tasks */}
        <ActiveTasksBar currentSessionId={session.id} />
      </div>
    </div>
  )
}

function ActiveTasksBar({ currentSessionId }: { currentSessionId: string }) {
  const { sessions, setActiveSession, markSessionViewed } = useSessionStore()
  const activeTasks = sessions.filter(s =>
    s.id !== currentSessionId && (s.isBackgroundRunning || s.hasUnviewedResult)
  )

  if (activeTasks.length === 0) return null

  return (
    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border-light overflow-x-auto">
      <span className="text-[10px] text-text-tertiary font-medium shrink-0">Active:</span>
      {activeTasks.map(s => (
        <button
          key={s.id}
          onClick={() => {
            setActiveSession(s.id)
            if (s.hasUnviewedResult) markSessionViewed(s.id)
          }}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-gray-50 hover:bg-gray-100 border border-border-light text-[10px] text-text-secondary transition-all shrink-0"
        >
          {s.isBackgroundRunning ? (
            <Loader2 className="w-3 h-3 animate-spin text-accent" />
          ) : s.hasUnviewedResult ? (
            <CheckCircle2 className="w-3 h-3 text-success" />
          ) : null}
          <span className="truncate max-w-[120px]">{s.name}</span>
        </button>
      ))}
    </div>
  )
}
