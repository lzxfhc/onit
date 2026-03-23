import { Loader2, CheckCircle2, XCircle, Clock, FolderOpen } from 'lucide-react'
import { useT } from '../../i18n'
import { useCopilotStore } from '../../stores/copilotStore'
import type { CopilotTask, CopilotTaskStatus } from '../../types'

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

  // Group persistent tasks by topic, keep temporary tasks separate
  const persistentByTopic = new Map<string, CopilotTask[]>()
  const temporaryTasks: CopilotTask[] = []
  const ungroupedPersistent: CopilotTask[] = []

  for (const task of tasks) {
    if (task.taskType === 'temporary') {
      temporaryTasks.push(task)
    } else if (task.topic) {
      const existing = persistentByTopic.get(task.topic) || []
      existing.push(task)
      persistentByTopic.set(task.topic, existing)
    } else {
      ungroupedPersistent.push(task)
    }
  }

  const hasContent = tasks.length > 0

  return (
    <div className="h-full flex flex-col bg-surface border-r border-border-subtle">
      <header className="px-4 py-3 border-b border-border-subtle">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
          {t.copilot.taskPanel}
        </h3>
      </header>

      <div className="flex-1 overflow-y-auto py-2">
        {!hasContent ? (
          <p className="px-4 py-6 text-xs text-text-tertiary text-center">
            {t.copilot.noTasks}
          </p>
        ) : (
          <>
            {/* Persistent session groups */}
            {Array.from(persistentByTopic.entries()).map(([topic, topicTasks]) => {
              const latestStatus = topicTasks[0]?.status
              return (
                <div key={topic} className="mb-2">
                  <div className="flex items-center gap-1.5 px-4 py-1.5">
                    <FolderOpen className="w-3 h-3 text-accent" />
                    <span className="text-[10px] font-semibold text-accent uppercase tracking-wider">{topic}</span>
                    <StatusIcon status={latestStatus} />
                  </div>
                  {topicTasks.map(task => (
                    <TaskCard key={task.id} task={task} isSelected={selectedTaskId === task.id} onClick={() => selectTask(task.id)} compact />
                  ))}
                </div>
              )
            })}

            {/* Ungrouped persistent tasks */}
            {ungroupedPersistent.map(task => (
              <TaskCard key={task.id} task={task} isSelected={selectedTaskId === task.id} onClick={() => selectTask(task.id)} />
            ))}

            {/* Temporary tasks (shown smaller) */}
            {temporaryTasks.length > 0 && (
              <>
                {(persistentByTopic.size > 0 || ungroupedPersistent.length > 0) && (
                  <div className="border-t border-border-light mx-3 my-2" />
                )}
                {temporaryTasks.map(task => (
                  <TaskCard key={task.id} task={task} isSelected={selectedTaskId === task.id} onClick={() => selectTask(task.id)} compact />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function TaskCard({ task, isSelected, onClick, compact }: {
  task: CopilotTask
  isSelected: boolean
  onClick: () => void
  compact?: boolean
}) {
  return (
    <div
      onClick={onClick}
      className={`${compact ? 'px-3 py-2' : 'p-3'} mx-2 rounded-lg border cursor-pointer transition-all duration-200 mb-1 ${
        isSelected
          ? 'border-accent/40 bg-accent-50/50'
          : 'border-transparent hover:border-accent/20 hover:bg-gray-50/50'
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusIcon status={task.status} />
        <span className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-charcoal truncate`}>
          {task.name}
        </span>
      </div>
      {!compact && (
        <p className="text-[10px] text-text-tertiary mt-1 truncate">
          {task.description}
        </p>
      )}
      <p className="text-[9px] text-text-tertiary mt-0.5">
        {formatTime(task.createdAt)}
      </p>
    </div>
  )
}
