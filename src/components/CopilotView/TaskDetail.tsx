import { X, Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { useT } from '../../i18n'
import { useCopilotStore } from '../../stores/copilotStore'
import MessageBubble from '../Chat/MessageBubble'
import type { CopilotTaskStatus } from '../../types'

function statusLabel(status: CopilotTaskStatus, t: any): string {
  switch (status) {
    case 'queued': return t.copilot.taskQueued
    case 'running': return t.copilot.taskRunning
    case 'completed': return t.copilot.taskCompleted
    case 'failed': return t.copilot.taskFailed
    case 'cancelled': return t.copilot.taskCancelled
    default: return status
  }
}

function StatusBadge({ status, t }: { status: CopilotTaskStatus; t: any }) {
  const label = statusLabel(status, t)
  switch (status) {
    case 'running':
      return (
        <span className="badge-blue flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          {label}
        </span>
      )
    case 'completed':
      return (
        <span className="badge-green flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" />
          {label}
        </span>
      )
    case 'failed':
      return (
        <span className="badge-red flex items-center gap-1">
          <XCircle className="w-3 h-3" />
          {label}
        </span>
      )
    default:
      return (
        <span className="badge-yellow flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {label}
        </span>
      )
  }
}

function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleString()
}

export default function TaskDetail() {
  const t = useT()
  const selectedTaskId = useCopilotStore(s => s.selectedTaskId)
  const tasks = useCopilotStore(s => s.tasks)
  const setTaskDetailOpen = useCopilotStore(s => s.setTaskDetailOpen)

  const task = tasks.find(tk => tk.id === selectedTaskId)

  return (
    <div className="h-full flex flex-col bg-surface border-l border-border-subtle">
      <header className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t.copilot.taskDetail}</h3>
        <button
          onClick={() => setTaskDetailOpen(false)}
          className="btn-icon w-6 h-6"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {!task ? (
          <p className="text-xs text-text-tertiary text-center mt-8">
            {t.copilot.noTaskSelected}
          </p>
        ) : (
          <div className="space-y-5">
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-charcoal">{task.name}</h4>
                <p className="text-xs text-text-secondary mt-1">{task.description}</p>
              </div>

              <div>
                <label className="label">Status</label>
                <StatusBadge status={task.status} t={t} />
              </div>

              <div>
                <label className="label">Created</label>
                <p className="text-xs text-charcoal">{formatDateTime(task.createdAt)}</p>
              </div>

              {task.completedAt && (
                <div>
                  <label className="label">Completed</label>
                  <p className="text-xs text-charcoal">{formatDateTime(task.completedAt)}</p>
                </div>
              )}

              {task.workspace && (
                <div>
                  <label className="label">Workspace</label>
                  <p className="text-xs text-charcoal font-mono break-all">{task.workspace}</p>
                </div>
              )}

              {task.skills && task.skills.length > 0 && (
                <div>
                  <label className="label">Skills</label>
                  <div className="flex flex-wrap gap-1">
                    {task.skills.map(skill => (
                      <span key={skill} className="badge-blue text-[10px]">{skill}</span>
                    ))}
                  </div>
                </div>
              )}

              {(task.finalResponse || task.summary) && (
                <div>
                  <label className="label">{t.copilot.taskLatestResult}</label>
                  <p className="text-xs text-charcoal leading-relaxed whitespace-pre-wrap break-words">
                    {task.finalResponse || task.summary}
                  </p>
                </div>
              )}
            </div>

            <div className="border-t border-border-light pt-4">
              <label className="label">{t.copilot.taskExecution}</label>
              {task.messages && task.messages.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {task.messages.map((message, index) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isLast={index === task.messages!.length - 1}
                      sessionId={task.sessionId}
                    />
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-text-tertiary">
                  {t.copilot.noTaskTranscript}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
