import { useState } from 'react'
import { Plus, Play, Trash2, ToggleLeft, ToggleRight, Edit3 } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import ScheduledTaskDialog from '../Dialogs/ScheduledTaskDialog'
import type { ScheduledTask } from '../../types'

export default function ScheduledTasks() {
  const { scheduledTasks, removeScheduledTask, toggleScheduledTask, runScheduledTaskNow } = useSettingsStore()
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null)

  const formatFrequency = (freq: string) => {
    const map: Record<string, string> = {
      manual: 'Manual',
      hourly: 'Every hour',
      daily: 'Every day',
      weekly: 'Every week',
      weekdays: 'Weekdays',
    }
    return map[freq] || freq
  }

  const formatTime = (ts: number | null) => {
    if (!ts) return '--'
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 pb-2">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
          Scheduled Tasks
        </span>
        <button
          onClick={() => setShowCreateDialog(true)}
          className="btn-icon w-6 h-6"
          title="Create Scheduled Task"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Task List */}
      {scheduledTasks.length === 0 ? (
        <div className="px-3 py-8 text-center">
          <p className="text-xs text-text-tertiary">No scheduled tasks</p>
          <button
            onClick={() => setShowCreateDialog(true)}
            className="text-xs text-accent hover:underline mt-2"
          >
            Create your first task
          </button>
        </div>
      ) : (
        <div className="space-y-1">
          {scheduledTasks.map(task => (
            <div key={task.id} className="card-hover p-3 mx-1">
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-medium text-charcoal truncate">
                    {task.name}
                  </h4>
                  <p className="text-xs text-text-tertiary mt-0.5 truncate">
                    {task.description}
                  </p>
                </div>
                <button
                  onClick={() => toggleScheduledTask(task.id, !task.enabled)}
                  className="shrink-0"
                  title={task.enabled ? 'Disable' : 'Enable'}
                >
                  {task.enabled ? (
                    <ToggleRight className="w-5 h-5 text-accent" />
                  ) : (
                    <ToggleLeft className="w-5 h-5 text-text-tertiary" />
                  )}
                </button>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-text-tertiary">
                <span>{formatFrequency(task.frequency)}</span>
                {task.lastRun && <span>Last: {formatTime(task.lastRun)}</span>}
              </div>
              <div className="flex items-center gap-1 mt-2">
                <button
                  onClick={() => runScheduledTaskNow(task.id)}
                  className="btn-ghost btn-sm text-[10px]"
                  title="Run now"
                >
                  <Play className="w-3 h-3" />
                  Run
                </button>
                <button
                  onClick={() => setEditingTask(task)}
                  className="btn-ghost btn-sm text-[10px]"
                >
                  <Edit3 className="w-3 h-3" />
                  Edit
                </button>
                <button
                  onClick={() => removeScheduledTask(task.id)}
                  className="btn-ghost btn-sm text-[10px] text-danger"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Dialog */}
      {showCreateDialog && (
        <ScheduledTaskDialog
          onClose={() => setShowCreateDialog(false)}
        />
      )}

      {/* Edit Dialog */}
      {editingTask && (
        <ScheduledTaskDialog
          task={editingTask}
          onClose={() => setEditingTask(null)}
        />
      )}
    </div>
  )
}
