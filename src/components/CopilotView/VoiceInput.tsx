import { useState, useRef, useCallback, useEffect } from 'react'
import { Mic, MicOff } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useT } from '../../i18n'

interface VoiceInputProps {
  onTranscript: (text: string) => void
  disabled?: boolean
}

type VoiceState = 'idle' | 'listening' | 'done'

export default function VoiceInput({ onTranscript, disabled }: VoiceInputProps) {
  const t = useT()
  const language = useSettingsStore(s => s.settings.language)
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const recognitionRef = useRef<any>(null)

  const isAvailable = typeof (window as any).webkitSpeechRecognition !== 'undefined'

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setVoiceState('idle')
  }, [])

  const startListening = useCallback(() => {
    if (!isAvailable || disabled) return

    const SpeechRecognition = (window as any).webkitSpeechRecognition
    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = language === 'zh' ? 'zh-CN' : 'en-US'

    recognition.onresult = (event: any) => {
      let finalText = ''
      for (let i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalText += event.results[i][0].transcript
        }
      }
      if (finalText) {
        onTranscript(finalText)
        setVoiceState('done')
        setTimeout(() => setVoiceState('idle'), 300)
      }
    }

    recognition.onerror = () => {
      setVoiceState('idle')
      recognitionRef.current = null
    }

    recognition.onend = () => {
      setVoiceState('idle')
      recognitionRef.current = null
    }

    recognitionRef.current = recognition
    recognition.start()
    setVoiceState('listening')
  }, [isAvailable, disabled, language, onTranscript])

  const toggleListening = useCallback(() => {
    if (voiceState === 'listening') {
      stopListening()
    } else {
      startListening()
    }
  }, [voiceState, stopListening, startListening])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop()
        recognitionRef.current = null
      }
    }
  }, [])

  const isListening = voiceState === 'listening'
  const isDisabled = disabled || !isAvailable

  return (
    <button
      onClick={toggleListening}
      disabled={isDisabled}
      className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center transition-all relative ${
        isListening
          ? 'text-red-500 hover:text-red-600'
          : isDisabled
            ? 'text-text-tertiary opacity-40 cursor-not-allowed'
            : 'text-text-secondary hover:text-charcoal'
      }`}
      title={
        !isAvailable
          ? t.copilot.voiceUnavailable
          : isListening
            ? t.copilot.voiceListening
            : undefined
      }
    >
      {isListening ? (
        <>
          <MicOff className="w-4 h-4" />
          <span className="absolute inset-0 rounded-full border-2 border-red-400 animate-ping opacity-40" />
        </>
      ) : (
        <Mic className="w-4 h-4" />
      )}
    </button>
  )
}
