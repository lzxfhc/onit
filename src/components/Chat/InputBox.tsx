import { memo, useState, useRef, useEffect, useCallback } from 'react'
import { shallow } from 'zustand/shallow'
import { pathBasename } from '../../utils/platform'
import {
  Send, Square, FolderOpen, Paperclip, ChevronDown,
  X, FileText, Shield, ShieldCheck, ShieldOff,
  Loader2, CheckCircle2, Sparkles
} from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { AVAILABLE_MODELS } from '../../types'
import type { PermissionMode, Skill } from '../../types'

interface Props {
  onSend: (content: string) => void | Promise<void>
  onStop: () => void | Promise<void>
  isRunning: boolean
  sessionId: string
}

function getMentionMatch(value: string, caretPosition: number) {
  const beforeCursor = value.slice(0, caretPosition)
  const match = beforeCursor.match(/(^|\s)@([\w-]*)$/)
  if (!match) return null

  const start = beforeCursor.lastIndexOf('@')
  if (start < 0) return null

  return {
    query: match[2] || '',
    start,
    end: caretPosition,
  }
}

function InputBox({ onSend, onStop, isRunning, sessionId }: Props) {
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
  const mentionRangeRef = useRef<{ start: number; end: number } | null>(null)

  const session = useSessionStore((state) => {
    const current = state.sessions.find(item => item.id === sessionId)
    return {
      id: sessionId,
      workspacePath: current?.workspacePath || null,
      permissionMode: current?.permissionMode || 'accept-edit',
      attachedFiles: current?.attachedFiles || [],
      model: current?.model || 'qianfan-code-latest',
      setWorkspace: state.setWorkspace,
      setPermissionMode: state.setPermissionMode,
      setModel: state.setModel,
      addAttachedFile: state.addAttachedFile,
      removeAttachedFile: state.removeAttachedFile,
    }
  }, shallow)

  const { settings, skills } = useSettingsStore((state) => ({
    settings: state.settings,
    skills: state.skills,
  }), shallow)

  const enabledSkills = skills.filter(skill => skill.enabled)

  const filteredMentionSkills = enabledSkills.filter(skill =>
    !mentionFilter ||
    skill.name.toLowerCase().includes(mentionFilter.toLowerCase()) ||
    skill.displayName.toLowerCase().includes(mentionFilter.toLowerCase()),
  )

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px'
    }
  }, [input])

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(event.target as Node)) {
        setShowModelPicker(false)
      }
      if (permPickerRef.current && !permPickerRef.current.contains(event.target as Node)) {
        setShowPermissionPicker(false)
      }
      if (mentionRef.current && !mentionRef.current.contains(event.target as Node)) {
        setShowSkillMention(false)
      }
    }

    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    const handler = (event: CustomEvent) => {
      if (event.detail?.text) {
        setInput(event.detail.text)
        setTimeout(() => textareaRef.current?.focus(), 100)
      }
    }

    window.addEventListener('onit:auto-input', handler as EventListener)
    return () => window.removeEventListener('onit:auto-input', handler as EventListener)
  }, [])

  const updateMentionState = useCallback((value: string, caretPosition: number) => {
    const match = getMentionMatch(value, caretPosition)
    if (!match) {
      mentionRangeRef.current = null
      setShowSkillMention(false)
      return
    }

    mentionRangeRef.current = { start: match.start, end: match.end }
    setMentionFilter(match.query)
    setShowSkillMention(true)
    setMentionIndex(0)
  }, [])

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value
    const caretPosition = event.target.selectionStart ?? value.length

    setInput(value)
    updateMentionState(value, caretPosition)
  }

  const insertMention = useCallback((skill: Skill) => {
    const mentionRange = mentionRangeRef.current
    if (!mentionRange) return

    const before = input.slice(0, mentionRange.start)
    const after = input.slice(mentionRange.end)
    const needsSpace = after.length > 0 && !after.startsWith(' ') ? ' ' : ''
    const nextValue = `${before}@${skill.name}${needsSpace}${after}`

    setInput(nextValue)
    setShowSkillMention(false)
    mentionRangeRef.current = null

    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      const cursor = before.length + skill.name.length + 1 + needsSpace.length
      textarea.focus()
      textarea.setSelectionRange(cursor, cursor)
    })
  }, [input])

  const handleSend = async () => {
    const trimmedInput = input.trim()

    if (isRunning) {
      await onStop()
      if (!trimmedInput) return
    } else if (!trimmedInput) {
      return
    }

    await onSend(trimmedInput)
    setInput('')
    setShowSkillMention(false)
    mentionRangeRef.current = null
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (isComposingRef.current) return

    if (showSkillMention && filteredMentionSkills.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionIndex(prev => Math.min(prev + 1, filteredMentionSkills.length - 1))
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex(prev => Math.max(prev - 1, 0))
        return
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        insertMention(filteredMentionSkills[mentionIndex])
        return
      }

      if (event.key === 'Escape') {
        setShowSkillMention(false)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  const handleSelectFolder = async () => {
    const folder = await window.electronAPI.selectFolder()
    if (folder) session.setWorkspace(session.id, folder)
  }

  const handleSelectFiles = async () => {
    const files = await window.electronAPI.selectFiles()
    for (const filePath of files) {
      session.addAttachedFile(session.id, filePath)
    }
  }

  const getModelName = () => {
    const selected = AVAILABLE_MODELS.find(item => item.id === session.model)
    return selected ? selected.name : session.model
  }

  const permissionModes: { id: PermissionMode; label: string; desc: string; icon: React.ReactNode }[] = [
    { id: 'plan', label: 'Plan Mode', desc: 'Confirm all operations', icon: <Shield className="w-3.5 h-3.5" /> },
    { id: 'accept-edit', label: 'AcceptEdit', desc: 'Smart confirmations', icon: <ShieldCheck className="w-3.5 h-3.5" /> },
    { id: 'full-access', label: 'Full Access', desc: 'Auto-execute all', icon: <ShieldOff className="w-3.5 h-3.5" /> },
  ]

  const currentPerm = permissionModes.find(item => item.id === session.permissionMode) || permissionModes[1]

  return (
    <div className="border-t border-border-subtle bg-surface px-4 py-3">
      <div className="max-w-3xl mx-auto">
        {session.attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {session.attachedFiles.map(filePath => (
              <span key={filePath} className="inline-flex items-center gap-1 px-2 py-1 bg-gray-50 border border-border-subtle rounded text-[10px] text-text-secondary">
                <FileText className="w-3 h-3" />
                {pathBasename(filePath)}
                <button
                  onClick={() => session.removeAttachedFile(session.id, filePath)}
                  className="hover:text-danger transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1 relative bg-canvas border border-border-subtle rounded-lg focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10 transition-all">
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
                        idx === mentionIndex ? 'bg-accent-50' : 'hover:bg-gray-50'
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
              onCompositionEnd={(event) => {
                isComposingRef.current = false
                updateMentionState(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)
              }}
              placeholder={isRunning ? 'Type to interrupt and send new instruction...' : 'Ask me anything... (type @ to invoke skills)'}
              className="w-full resize-none bg-transparent px-4 py-3 text-sm text-charcoal placeholder:text-text-tertiary focus:outline-none"
              rows={1}
              style={{ minHeight: '44px', maxHeight: '200px' }}
            />

            <div className="flex items-center gap-1 px-2 pb-2">
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
                {session.workspacePath ? pathBasename(session.workspacePath) : 'Workspace'}
              </button>

              <button
                onClick={handleSelectFiles}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-text-tertiary hover:bg-gray-100 hover:text-text-secondary transition-all"
                title="Attach files"
              >
                <Paperclip className="w-3 h-3" />
                Attach
              </button>

              <div className="relative ml-auto" ref={modelPickerRef}>
                <button
                  onClick={() => setShowModelPicker(prev => !prev)}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-text-tertiary hover:bg-gray-100 hover:text-text-secondary transition-all"
                >
                  {getModelName()}
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showModelPicker && (
                  <div className="absolute bottom-full right-0 mb-1 bg-surface border border-border-subtle rounded shadow-card-hover py-1 min-w-[180px] z-50 animate-fade-in">
                    {AVAILABLE_MODELS
                      .filter(model => settings.apiConfig.billingMode === 'coding-plan' ? model.codingPlan : !model.codingPlan)
                      .map(model => (
                        <button
                          key={model.id}
                          onClick={() => {
                            session.setModel(session.id, model.id)
                            setShowModelPicker(false)
                          }}
                          className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                            session.model === model.id
                              ? 'bg-accent-50 text-accent-700'
                              : 'text-text-secondary hover:bg-gray-50'
                          }`}
                        >
                          {model.name}
                        </button>
                      ))}
                  </div>
                )}
              </div>

              <div className="relative" ref={permPickerRef}>
                <button
                  onClick={() => setShowPermissionPicker(prev => !prev)}
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
                    {permissionModes.map(mode => (
                      <button
                        key={mode.id}
                        onClick={() => {
                          session.setPermissionMode(session.id, mode.id)
                          setShowPermissionPicker(false)
                        }}
                        className={`w-full text-left px-3 py-2 transition-colors ${
                          session.permissionMode === mode.id ? 'bg-accent-50' : 'hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {mode.icon}
                          <span className="text-xs font-medium text-charcoal">{mode.label}</span>
                        </div>
                        <p className="text-[10px] text-text-tertiary mt-0.5 ml-5.5">{mode.desc}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <button
            onClick={() => { void handleSend() }}
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

        <ActiveTasksBar currentSessionId={session.id} />
      </div>
    </div>
  )
}

function ActiveTasksBar({ currentSessionId }: { currentSessionId: string }) {
  const { sessions, setActiveSession, markSessionViewed } = useSessionStore((state) => ({
    sessions: state.sessions,
    setActiveSession: state.setActiveSession,
    markSessionViewed: state.markSessionViewed,
  }), shallow)

  const activeTasks = sessions.filter(session =>
    session.id !== currentSessionId && (session.isBackgroundRunning || session.hasUnviewedResult),
  )

  if (activeTasks.length === 0) return null

  return (
    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border-light overflow-x-auto">
      <span className="text-[10px] text-text-tertiary font-medium shrink-0">Active:</span>
      {activeTasks.map(session => (
        <button
          key={session.id}
          onClick={() => {
            setActiveSession(session.id)
            if (session.hasUnviewedResult) markSessionViewed(session.id)
          }}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-gray-50 hover:bg-gray-100 border border-border-light text-[10px] text-text-secondary transition-all shrink-0"
        >
          {session.isBackgroundRunning ? (
            <Loader2 className="w-3 h-3 animate-spin text-accent" />
          ) : session.hasUnviewedResult ? (
            <CheckCircle2 className="w-3 h-3 text-success" />
          ) : null}
          <span className="truncate max-w-[120px]">{session.name}</span>
        </button>
      ))}
    </div>
  )
}

export default memo(InputBox)
