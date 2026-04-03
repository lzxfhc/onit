import { memo, useState, useRef, useEffect, useCallback } from 'react'
import { shallow } from 'zustand/shallow'
import { useT } from '../../i18n'
import { pathBasename } from '../../utils/platform'
import {
  Send, Square, FolderOpen, Paperclip, ChevronDown,
  X, FileText, Shield, ShieldCheck, ShieldOff,
  Loader2, CheckCircle2, Sparkles
} from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { AVAILABLE_MODELS, AVAILABLE_LOCAL_MODELS } from '../../types'
import type { PermissionMode, Skill } from '../../types'

interface Props {
  onSend: (content: string) => void | Promise<void>
  onStop: () => void | Promise<void>
  isRunning: boolean
  sessionId: string
}

// ---------------------------------------------------------------------------
// ContentEditable helpers
// ---------------------------------------------------------------------------

/** Extract plain text from the editor, converting mention spans to @name */
function extractText(el: HTMLElement): string {
  let text = ''
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || ''
    } else if (node instanceof HTMLElement) {
      if (node.dataset.mention) {
        text += `@${node.dataset.mention}`
      } else if (node.tagName === 'BR') {
        text += '\n'
      } else {
        text += extractText(node)
      }
    }
  }
  return text
}

/** Get caret offset (character position) inside the editor */
function getCaretOffset(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return 0
  const range = sel.getRangeAt(0).cloneRange()
  range.selectNodeContents(el)
  range.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset)
  return range.toString().length
}

/** Get text before caret (for @ detection) */
function getTextBeforeCaret(el: HTMLElement): string {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return ''
  const range = sel.getRangeAt(0).cloneRange()
  range.selectNodeContents(el)
  range.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset)

  // Walk the fragment and extract text, treating mention spans as @name
  const fragment = range.cloneContents()
  const temp = document.createElement('div')
  temp.appendChild(fragment)
  return extractText(temp)
}

/** Create a mention span element */
function createMentionSpan(skillName: string, displayName: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.contentEditable = 'false'
  span.dataset.mention = skillName
  span.className = 'inline-block rounded bg-accent/10 text-accent text-sm font-medium px-1 mx-0.5 select-none align-baseline'
  span.style.cursor = 'default'
  span.textContent = `@${displayName}`
  return span
}

/** Place caret after a given node */
function placeCaretAfter(node: Node) {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.setStartAfter(node)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

// ---------------------------------------------------------------------------
// InputBox Component
// ---------------------------------------------------------------------------

function InputBox({ onSend, onStop, isRunning, sessionId }: Props) {
  const t = useT()
  const [input, setInput] = useState('')
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [showPermissionPicker, setShowPermissionPicker] = useState(false)
  const [showSkillMention, setShowSkillMention] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const isComposingRef = useRef(false)
  const editorRef = useRef<HTMLDivElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const permPickerRef = useRef<HTMLDivElement>(null)
  const mentionRef = useRef<HTMLDivElement>(null)
  /** Stores the Range to replace when a mention is selected from the dropdown */
  const mentionRangeRef = useRef<Range | null>(null)

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

  // Close dropdowns on outside click
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

  // Handle auto-input event (e.g., from "Create with Onit")
  useEffect(() => {
    const handler = (event: CustomEvent) => {
      if (event.detail?.text && editorRef.current) {
        editorRef.current.textContent = event.detail.text
        setInput(event.detail.text)
        setTimeout(() => editorRef.current?.focus(), 100)
      }
    }

    window.addEventListener('onit:auto-input', handler as EventListener)
    return () => window.removeEventListener('onit:auto-input', handler as EventListener)
  }, [])

  // Detect @ mention pattern from text before caret
  const updateMentionState = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return

    const beforeCaret = getTextBeforeCaret(editor)
    const match = beforeCaret.match(/(^|\s)@([\w-]*)$/)

    if (!match) {
      mentionRangeRef.current = null
      setShowSkillMention(false)
      return
    }

    // Save the range that covers the @query so we can replace it later
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0).cloneRange()
      // Move start back to cover the @query
      const queryLen = match[2].length + 1 // +1 for @
      for (let i = 0; i < queryLen; i++) {
        range.setStart(range.startContainer, Math.max(0, range.startOffset - 1))
        // If we hit the start of a text node, walk to previous
        if (range.startOffset === 0 && range.startContainer.previousSibling) {
          const prev = range.startContainer.previousSibling
          if (prev.nodeType === Node.TEXT_NODE) {
            range.setStart(prev, (prev.textContent?.length || 0) - (queryLen - i - 1))
            break
          }
        }
      }
      mentionRangeRef.current = range
    }

    setMentionFilter(match[2] || '')
    setShowSkillMention(true)
    setMentionIndex(0)
  }, [])

  // Handle contentEditable input
  const handleInput = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const text = extractText(editor)
    setInput(text)
    updateMentionState()
  }, [updateMentionState])

  // Insert mention span at the @query position
  const insertMention = useCallback((skill: Skill) => {
    const editor = editorRef.current
    if (!editor) return

    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return

    // Find the @query text to replace
    const beforeCaret = getTextBeforeCaret(editor)
    const match = beforeCaret.match(/(^|\s)@([\w-]*)$/)
    if (!match) return

    const range = sel.getRangeAt(0)
    const node = range.startContainer
    const offset = range.startOffset

    if (node.nodeType !== Node.TEXT_NODE || !node.textContent) return

    // Find @ position in the text node
    const textBefore = node.textContent.slice(0, offset)
    const atIdx = textBefore.lastIndexOf('@')
    if (atIdx < 0) return

    // Split the text node: [before @] [@ query] [after cursor]
    const textNode = node as Text
    const afterText = textNode.textContent.slice(offset)
    const beforeText = textNode.textContent.slice(0, atIdx)

    // Build: beforeText + mentionSpan + space + afterText
    const mentionSpan = createMentionSpan(skill.name, skill.displayName)
    const spaceNode = document.createTextNode('\u00A0') // non-breaking space after mention

    // Replace the text node content
    textNode.textContent = beforeText
    // Insert mention span and space after the text node
    const parent = textNode.parentNode!
    const nextSibling = textNode.nextSibling
    parent.insertBefore(mentionSpan, nextSibling)
    parent.insertBefore(spaceNode, mentionSpan.nextSibling)

    // If there was text after the cursor, add it back
    if (afterText) {
      const afterNode = document.createTextNode(afterText)
      parent.insertBefore(afterNode, spaceNode.nextSibling)
    }

    // Place cursor after the space (after the mention)
    placeCaretAfter(spaceNode)

    // Update state
    setInput(extractText(editor))
    setShowSkillMention(false)
    mentionRangeRef.current = null
  }, [])

  const handleSend = async () => {
    const trimmedInput = input.trim()

    if (isRunning) {
      await onStop()
      if (!trimmedInput) return
    } else if (!trimmedInput) {
      return
    }

    // Clear editor
    if (editorRef.current) {
      editorRef.current.innerHTML = ''
    }
    setInput('')
    setShowSkillMention(false)
    mentionRangeRef.current = null
    await onSend(trimmedInput)
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (isComposingRef.current) return

    // Mention dropdown navigation
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

    // Enter to send
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  // Handle paste — strip formatting, keep plain text
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
  }, [])

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
    if (settings.apiConfig.billingMode === 'local-model') {
      const local = AVAILABLE_LOCAL_MODELS.find(m => m.id === settings.apiConfig.localModelId)
      return local ? local.displayName : session.model
    }
    const selected = AVAILABLE_MODELS.find(item => item.id === session.model)
    return selected ? selected.name : session.model
  }

  const permissionModes: { id: PermissionMode; label: string; desc: string; icon: React.ReactNode }[] = [
    { id: 'plan', label: t.chat.planMode, desc: t.chat.planModeDesc, icon: <Shield className="w-3.5 h-3.5" /> },
    { id: 'accept-edit', label: t.chat.acceptEdit, desc: t.chat.acceptEditDesc, icon: <ShieldCheck className="w-3.5 h-3.5" /> },
    { id: 'full-access', label: t.chat.fullAccess, desc: t.chat.fullAccessDesc, icon: <ShieldOff className="w-3.5 h-3.5" /> },
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
            {/* Mention dropdown */}
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

            {/* ContentEditable editor */}
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onCompositionStart={() => { isComposingRef.current = true }}
              onCompositionEnd={() => {
                isComposingRef.current = false
                handleInput()
              }}
              data-placeholder={isRunning ? t.chat.interruptPlaceholder : t.chat.inputPlaceholder}
              className="w-full px-4 py-3 text-sm text-charcoal focus:outline-none overflow-y-auto empty:before:content-[attr(data-placeholder)] empty:before:text-text-tertiary empty:before:pointer-events-none"
              style={{ minHeight: '44px', maxHeight: '200px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
              role="textbox"
              aria-multiline="true"
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
                {session.workspacePath ? pathBasename(session.workspacePath) : t.chat.workspace}
              </button>

              <button
                onClick={handleSelectFiles}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-text-tertiary hover:bg-gray-100 hover:text-text-secondary transition-all"
                title="Attach files"
              >
                <Paperclip className="w-3 h-3" />
                {t.chat.attach}
              </button>

              <div className="relative ml-auto" ref={modelPickerRef}>
                <button
                  onClick={() => {
                    if (settings.apiConfig.billingMode !== 'local-model') {
                      setShowModelPicker(prev => !prev)
                    }
                  }}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] text-text-tertiary transition-all ${
                    settings.apiConfig.billingMode === 'local-model'
                      ? 'cursor-default'
                      : 'hover:bg-gray-100 hover:text-text-secondary'
                  }`}
                >
                  {getModelName()}
                  {settings.apiConfig.billingMode !== 'local-model' && <ChevronDown className="w-3 h-3" />}
                </button>
                {showModelPicker && settings.apiConfig.billingMode !== 'local-model' && (
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
  const t = useT()
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
      <span className="text-[10px] text-text-tertiary font-medium shrink-0">{t.chat.active}</span>
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
