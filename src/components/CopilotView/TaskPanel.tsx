import { Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { useT } from '../../i18n'
import { useCopilotStore } from '../../stores/copilotStore'
import type { CopilotTaskStatus } from '../../types'

function StatusIcon({ status }: { status: CopilotTaskStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 text-accent animate-spin shrink-0" />
    case 'completed':
      return <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-danger shrink-0" />
    case 'queued':
    case 'cancelled':
    default:
      return <Clock className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  return `${hh}:${mm}`
}

export default function TaskPanel() {
  const t = useT()
  const tasks = useCopilotStore(s => s.tasks)
  const selectedTaskId = useCopilotStore(s => s.selectedTaskId)
  const selectTask = useCopilotStore(s => s.selectTask)

  return (
    <div className="h-full flex flex-col bg-surface border-r border-border-subtle">
      <header className="px-4 py-3 border-b border-border-subtle">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
          {t.copilot.taskPanel}
        </h3>
      </header>

      <div className="flex-1 overflow-y-auto py-2">
        {tasks.length === 0 ? (
          <p className="px-4 py-6 text-xs text-text-tertiary text-center">
            {t.copilot.noTasks}
          </p>
        ) : (
          tasks.map(task => (
            <div
              key={task.id}
              onClick={() => selectTask(task.id)}
              className={`p-3 mx-2 rounded-lg border cursor-pointer transition-all duration-200 mb-1.5 ${
                selectedTaskId === task.id
                  ? 'border-accent/40 bg-accent-50/50'
                  : 'border-border-light hover:border-accent/30'
              }`}
            >
              <div className="flex items-center gap-2">
                <StatusIcon status={task.status} />
                <span className="text-sm font-medium text-charcoal truncate">
                  {task.name}
                </span>
              </div>
              <p className="text-[10px] text-text-tertiary mt-1 truncate">
                {task.description}
              </p>
              <p className="text-[9px] text-text-tertiary mt-0.5">
                {formatTime(task.createdAt)}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
