import { useState } from 'react'
import { MessageCircleQuestion, Check, ChevronRight } from 'lucide-react'
import type { PermissionRequest, UserQuestion } from '../../types'
import { useT } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'

interface Props {
  request: PermissionRequest
}

export default function QuestionDialog({ request }: Props) {
  const t = useT()
  const { removePermissionRequest } = useSettingsStore()
  const questions: UserQuestion[] = request.questions || []
  const [answers, setAnswers] = useState<Map<number, string>>(new Map())
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(new Map())
  const [currentQ, setCurrentQ] = useState(0)

  const handleSelect = (qIdx: number, label: string) => {
    setAnswers(prev => {
      const next = new Map(prev)
      const q = questions[qIdx]
      if (q?.multiSelect) {
        const current = next.get(qIdx) || ''
        const selected = current ? current.split(', ') : []
        if (selected.includes(label)) {
          next.set(qIdx, selected.filter(s => s !== label).join(', '))
        } else {
          next.set(qIdx, [...selected, label].join(', '))
        }
      } else {
        next.set(qIdx, label)
        // Auto-advance on single-select
        if (qIdx < questions.length - 1) {
          setTimeout(() => setCurrentQ(qIdx + 1), 150)
        }
      }
      return next
    })
  }

  const handleOtherChange = (qIdx: number, text: string) => {
    setOtherTexts(prev => new Map(prev).set(qIdx, text))
  }

  const handleOtherSubmit = (qIdx: number) => {
    const text = otherTexts.get(qIdx)?.trim()
    if (!text) return
    setAnswers(prev => new Map(prev).set(qIdx, text))
    if (qIdx < questions.length - 1) {
      setTimeout(() => setCurrentQ(qIdx + 1), 150)
    }
  }

  const isSelected = (qIdx: number, label: string) => {
    const answer = answers.get(qIdx) || ''
    if (questions[qIdx]?.multiSelect) {
      return answer.split(', ').includes(label)
    }
    return answer === label
  }

  const allAnswered = questions.every((_, i) => answers.has(i) && answers.get(i))

  const handleSubmit = () => {
    const answerLines = questions.map((q, i) => {
      const answer = answers.get(i) || '(no answer)'
      return `"${q.question}" = "${answer}"`
    })
    const answerText = `User has answered your questions:\n${answerLines.join('\n')}\n\nYou can now continue with the user's answers in mind.`

    window.electronAPI.sendPermissionResponse({
      requestId: request.id,
      approved: true,
      answerText,
    })
    removePermissionRequest(request.id)
  }

  const handleSkip = () => {
    window.electronAPI.sendPermissionResponse({
      requestId: request.id,
      approved: true,
      answerText: 'User skipped the questions. Proceed with your best judgment.',
    })
    removePermissionRequest(request.id)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-lg shadow-xl w-[520px] max-h-[80vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-subtle">
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center">
            <MessageCircleQuestion className="w-5 h-5 text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-charcoal">{t.question?.title || 'Agent is asking you'}</div>
            <div className="text-xs text-text-tertiary">
              {questions.length > 1 ? `${t.question?.questionOf || 'Question'} ${currentQ + 1} / ${questions.length}` : ''}
            </div>
          </div>
        </div>

        {/* Question content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {questions.map((q, qIdx) => (
            <div key={qIdx} className={qIdx === currentQ ? '' : 'hidden'}>
              <p className="text-sm font-medium text-charcoal mb-3">{q.question}</p>
              <div className="space-y-2">
                {q.options.map((opt, oIdx) => (
                  <button
                    key={oIdx}
                    onClick={() => handleSelect(qIdx, opt.label)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all duration-150 ${
                      isSelected(qIdx, opt.label)
                        ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
                        : 'border-border-subtle hover:border-accent/40 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                        isSelected(qIdx, opt.label)
                          ? 'border-accent bg-accent'
                          : 'border-gray-300'
                      }`}>
                        {isSelected(qIdx, opt.label) && <Check className="w-2.5 h-2.5 text-white" />}
                      </div>
                      <span className="text-sm font-medium text-charcoal">{opt.label}</span>
                    </div>
                    {opt.description && (
                      <p className="text-xs text-text-tertiary mt-1 ml-6">{opt.description}</p>
                    )}
                  </button>
                ))}

                {/* Other option */}
                <div className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all duration-150 ${
                  answers.get(qIdx) && !q.options.some(o => o.label === answers.get(qIdx))
                    ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
                    : 'border-border-subtle'
                }`}>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full border-2 border-gray-300 shrink-0" />
                    <input
                      type="text"
                      placeholder={t.question?.otherPlaceholder || 'Other (type your answer)'}
                      value={otherTexts.get(qIdx) || ''}
                      onChange={e => handleOtherChange(qIdx, e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleOtherSubmit(qIdx) }}
                      className="flex-1 text-sm bg-transparent outline-none placeholder:text-text-tertiary"
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Navigation + Submit */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border-subtle bg-gray-50/50">
          <div className="flex items-center gap-2">
            {questions.length > 1 && currentQ > 0 && (
              <button onClick={() => setCurrentQ(currentQ - 1)} className="text-xs text-text-secondary hover:text-charcoal transition-colors">
                {t.question?.prev || 'Previous'}
              </button>
            )}
            {questions.length > 1 && currentQ < questions.length - 1 && (
              <button onClick={() => setCurrentQ(currentQ + 1)} className="text-xs text-accent hover:text-accent-dark transition-colors flex items-center gap-0.5">
                {t.question?.next || 'Next'} <ChevronRight className="w-3 h-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSkip}
              className="px-3 py-1.5 text-xs text-text-secondary hover:text-charcoal transition-colors"
            >
              {t.question?.skip || 'Skip'}
            </button>
            <button
              onClick={handleSubmit}
              disabled={!allAnswered}
              className="btn-primary text-xs px-4 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t.question?.submit || 'Submit'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
