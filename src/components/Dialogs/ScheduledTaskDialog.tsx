import { useState } from 'react'
import { X, FolderOpen, ChevronDown } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { AVAILABLE_MODELS } from '../../types'
import type { ScheduledTask, ScheduledFrequency } from '../../types'
import { useT } from '../../i18n'

interface Props {
  task?: ScheduledTask
  onClose: () => void
}

export default function ScheduledTaskDialog({ task, onClose }: Props) {
  const t = useT()
  const { addScheduledTask, updateScheduledTask, settings } = useSettingsStore()
  const isEditing = !!task

  const [name, setName] = useState(task?.name || '')
  const [description, setDescription] = useState(task?.description || '')
  const [taskPrompt, setTaskPrompt] = useState(task?.taskPrompt || '')
  const [model, setModel] = useState(task?.model || 'qianfan-code-latest')
  const [workspacePath, setWorkspacePath] = useState(task?.workspacePath || '')
  const [frequency, setFrequency] = useState<ScheduledFrequency>(task?.frequency || 'manual')
  const [scheduleTime, setScheduleTime] = useState(task?.scheduleTime || '09:00')
  const [scheduleDayOfWeek, setScheduleDayOfWeek] = useState(task?.scheduleDayOfWeek ?? 1)
  const [scheduleDayOfMonth, setScheduleDayOfMonth] = useState(task?.scheduleDayOfMonth ?? 1)
  const [scheduleDateTime, setScheduleDateTime] = useState(task?.scheduleDateTime || '')
  const [error, setError] = useState('')

  const handleSelectFolder = async () => {
    const folder = await window.electronAPI.selectFolder()
    if (folder) setWorkspacePath(folder)
  }

  const handleSave = async () => {
    if (!name.trim()) { setError('Task name is required'); return }
    if (!description.trim()) { setError('Description is required'); return }
    if (!taskPrompt.trim()) { setError('Task prompt is required'); return }
    if (frequency === 'once' && !scheduleDateTime) { setError('Please select a date and time'); return }

    const data: any = {
      name: name.trim(),
      description: description.trim(),
      taskPrompt: taskPrompt.trim(),
      model,
      workspacePath: workspacePath || null,
      frequency,
    }

    // Add scheduling fields based on frequency
    if (frequency === 'once') {
      data.scheduleDateTime = scheduleDateTime
    } else if (frequency !== 'manual') {
      data.scheduleTime = scheduleTime
      if (frequency === 'weekly') {
        data.scheduleDayOfWeek = scheduleDayOfWeek
      }
      if (frequency === 'monthly') {
        data.scheduleDayOfMonth = scheduleDayOfMonth
      }
    }

    if (isEditing && task) {
      await updateScheduledTask({ ...task, ...data })
    } else {
      await addScheduledTask(data)
    }

    onClose()
  }

  const frequencies: { id: ScheduledFrequency; label: string }[] = [
    { id: 'manual', label: t.scheduled.manual },
    { id: 'once', label: t.scheduled.once },
    { id: 'hourly', label: t.scheduled.hourly },
    { id: 'daily', label: t.scheduled.daily },
    { id: 'weekly', label: t.scheduled.weekly },
    { id: 'monthly', label: t.scheduled.monthly },
    { id: 'weekdays', label: t.scheduled.weekdays },
  ]

  const days = [t.scheduled.sunday, t.scheduled.monday, t.scheduled.tuesday, t.scheduled.wednesday, t.scheduled.thursday, t.scheduled.friday, t.scheduled.saturday]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-charcoal/20 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-surface rounded-lg shadow-dialog w-full max-w-lg mx-4 animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between p-5 pb-3">
          <h3 className="text-sm font-semibold text-charcoal">
            {isEditing ? t.scheduled.editTask : t.scheduled.createTask}
          </h3>
          <button onClick={onClose} className="btn-icon">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <div className="px-5 pb-4 space-y-4">
          {/* Name */}
          <div>
            <label className="label">{t.scheduled.taskName}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError('') }}
              placeholder={t.scheduled.taskNamePlaceholder}
              className="input"
            />
          </div>

          {/* Description */}
          <div>
            <label className="label">{t.scheduled.description}</label>
            <input
              type="text"
              value={description}
              onChange={(e) => { setDescription(e.target.value); setError('') }}
              placeholder={t.scheduled.descriptionPlaceholder}
              className="input"
            />
          </div>

          {/* Task Prompt */}
          <div>
            <label className="label">{t.scheduled.instructions}</label>
            <textarea
              value={taskPrompt}
              onChange={(e) => { setTaskPrompt(e.target.value); setError('') }}
              placeholder={t.scheduled.instructionsPlaceholder}
              className="input min-h-[100px] resize-y"
              rows={4}
            />
          </div>

          {/* Model & Frequency row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Model</label>
              <div className="relative">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="input appearance-none pr-8 text-xs"
                >
                  {AVAILABLE_MODELS.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none" />
              </div>
            </div>

            <div>
              <label className="label">{t.scheduled.frequency}</label>
              <div className="relative">
                <select
                  value={frequency}
                  onChange={(e) => { setFrequency(e.target.value as ScheduledFrequency); setError('') }}
                  className="input appearance-none pr-8 text-xs"
                >
                  {frequencies.map(f => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Scheduling options based on frequency */}
          {frequency === 'once' && (
            <div>
              <label className="label">{t.scheduled.dateTime}</label>
              <input
                type="datetime-local"
                value={scheduleDateTime}
                onChange={(e) => { setScheduleDateTime(e.target.value); setError('') }}
                className="input text-xs"
                min={new Date().toISOString().slice(0, 16)}
              />
            </div>
          )}

          {frequency === 'hourly' && (
            <div>
              <label className="label">{t.scheduled.atMinute}</label>
              <div className="relative">
                <select
                  value={scheduleTime.split(':')[1] || '00'}
                  onChange={(e) => setScheduleTime(`00:${e.target.value}`)}
                  className="input appearance-none pr-8 text-xs"
                >
                  {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                    <option key={m} value={String(m).padStart(2, '0')}>:{String(m).padStart(2, '0')}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none" />
              </div>
            </div>
          )}

          {(frequency === 'daily' || frequency === 'weekdays') && (
            <div>
              <label className="label">{t.scheduled.time}</label>
              <input
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                className="input text-xs"
              />
            </div>
          )}

          {frequency === 'weekly' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">{t.scheduled.dayOfWeek}</label>
                <div className="relative">
                  <select
                    value={scheduleDayOfWeek}
                    onChange={(e) => setScheduleDayOfWeek(parseInt(e.target.value))}
                    className="input appearance-none pr-8 text-xs"
                  >
                    {days.map((day, idx) => (
                      <option key={idx} value={idx}>{day}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none" />
                </div>
              </div>
              <div>
                <label className="label">{t.scheduled.time}</label>
                <input
                  type="time"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                  className="input text-xs"
                />
              </div>
            </div>
          )}

          {frequency === 'monthly' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">{t.scheduled.dayOfMonth}</label>
                <div className="relative">
                  <select
                    value={scheduleDayOfMonth}
                    onChange={(e) => setScheduleDayOfMonth(parseInt(e.target.value))}
                    className="input appearance-none pr-8 text-xs"
                  >
                    {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none" />
                </div>
              </div>
              <div>
                <label className="label">{t.scheduled.time}</label>
                <input
                  type="time"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                  className="input text-xs"
                />
              </div>
            </div>
          )}

          {/* Workspace */}
          <div>
            <label className="label">{t.scheduled.workspace}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                placeholder={t.scheduled.noWorkspace}
                className="input flex-1 text-xs"
                readOnly
              />
              <button
                onClick={handleSelectFolder}
                className="btn-secondary btn-sm shrink-0"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {t.scheduled.browse}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="text-xs text-danger animate-fade-in">{error}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 p-5 pt-0">
          <button onClick={onClose} className="btn-secondary">
            {t.common.cancel}
          </button>
          <button onClick={handleSave} className="btn-primary">
            {isEditing ? t.scheduled.saveChanges : t.scheduled.createTask}
          </button>
        </div>
      </div>
    </div>
  )
}
