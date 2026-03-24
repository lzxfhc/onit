import { useState, useRef, useCallback, type KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import { useT } from '../../i18n'
import VoiceInput from './VoiceInput'

interface Props {
  onSend: (content: string) => void | Promise<void>
  onStop: () => void | Promise<void>
  isRunning: boolean
}

export default function CopilotInputBox({ onSend, onStop, isRunning }: Props) {
  const t = useT()
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || isRunning) return
    onSend(trimmed)
    setText('')
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, isRunning, onSend])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleVoiceTranscript = useCallback((transcript: string) => {
    setText(prev => prev ? `${prev} ${transcript}` : transcript)
    textareaRef.current?.focus()
  }, [])

  const handleInput = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [])

  return (
    <div className="shrink-0 border-t border-border-subtle bg-surface px-4 py-3">
      <div className="flex items-center gap-2 max-w-3xl mx-auto">
        {/* Voice input */}
        <VoiceInput onTranscript={handleVoiceTranscript} disabled={isRunning} />

        {/* Text area */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder={t.copilot.inputPlaceholder}
            disabled={isRunning}
            rows={1}
            className="w-full resize-none rounded-lg border border-border-subtle bg-white px-3 py-2.5 text-sm text-charcoal placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-all duration-200 disabled:opacity-50"
            style={{ minHeight: '40px', maxHeight: '200px' }}
          />
        </div>

        {/* Send / Stop button */}
        {isRunning ? (
          <button
            onClick={() => onStop()}
            className="shrink-0 w-10 h-10 rounded-lg flex items-center justify-center bg-danger text-white hover:bg-red-600 transition-all"
            title="Stop"
          >
            <Square className="w-4 h-4" fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim()}
            className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
              text.trim()
                ? 'bg-accent text-white hover:bg-accent-hover'
                : 'bg-gray-100 text-text-tertiary cursor-not-allowed'
            }`}
            title="Send"
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}
