import { useState } from 'react'
import { FileText, Check, X } from 'lucide-react'
import type { PermissionRequest } from '../../types'
import { useT } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  request: PermissionRequest
}

export default function PlanApprovalDialog({ request }: Props) {
  const t = useT()
  const { removePermissionRequest } = useSettingsStore()
  const planContent = request.planContent || request.description || ''
  const keyActions = request.planFiles || [] // planFiles used for backwards compat; now holds keyActions
  const [feedback, setFeedback] = useState('')
  const [showFeedback, setShowFeedback] = useState(false)

  const handleApprove = () => {
    window.electronAPI.sendPermissionResponse({
      requestId: request.id,
      approved: true,
    })
    removePermissionRequest(request.id)
  }

  const handleReject = () => {
    if (!showFeedback) {
      setShowFeedback(true)
      return
    }
    window.electronAPI.sendPermissionResponse({
      requestId: request.id,
      approved: false,
      answerText: feedback.trim() || undefined,
    })
    removePermissionRequest(request.id)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-lg shadow-xl w-[640px] max-h-[85vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-subtle">
          <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center">
            <FileText className="w-5 h-5 text-green-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-charcoal">{t.plan?.approvalTitle || 'Plan Ready for Review'}</div>
            <div className="text-xs text-text-tertiary">{t.plan?.approvalSubtitle || 'Review the plan below and approve to start implementation'}</div>
          </div>
        </div>

        {/* Plan content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Summary */}
          <div className="text-sm text-charcoal mb-3">{request.description}</div>

          {/* Key actions */}
          {keyActions.length > 0 && (
            <div className="mb-3">
              <div className="text-xs font-medium text-text-tertiary mb-1.5">{t.plan?.keyActions || 'Key actions:'}</div>
              <div className="flex flex-wrap gap-1">
                {keyActions.map((action, i) => (
                  <span key={i} className="text-[10px] px-2 py-0.5 bg-gray-100 rounded text-text-secondary font-mono">
                    {action}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Full plan markdown */}
          <div className="border border-border-subtle rounded-lg p-4 bg-gray-50/50 max-h-80 overflow-y-auto">
            <div className="markdown-content text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{planContent}</ReactMarkdown>
            </div>
          </div>

          {/* Feedback input (shown on first reject click) */}
          {showFeedback && (
            <div className="mt-3">
              <textarea
                value={feedback}
                onChange={e => setFeedback(e.target.value)}
                placeholder={t.plan?.feedbackPlaceholder || 'Tell the agent what to change...'}
                className="input w-full text-sm h-20 resize-none"
                autoFocus
              />
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle bg-gray-50/50">
          <button
            onClick={handleReject}
            className="px-4 py-2 text-sm text-text-secondary hover:text-danger border border-border-subtle rounded-lg hover:border-danger/30 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <X className="w-3.5 h-3.5" />
              {showFeedback ? (t.plan?.submitFeedback || 'Send Feedback') : (t.plan?.reject || 'Reject')}
            </span>
          </button>
          <button
            onClick={handleApprove}
            className="btn-primary text-sm px-4 py-2"
          >
            <span className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" />
              {t.plan?.approve || 'Approve & Start'}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
