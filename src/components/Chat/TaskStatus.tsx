import { memo, useMemo, useState } from 'react'
import {
  CheckCircle2, Circle, Loader2, Wrench, FileText,
  FolderOpen, ChevronRight, XCircle
} from 'lucide-react'
import { useT } from '../../i18n'
import type { Session, TaskItem, ToolCall, WorkspaceFile } from '../../types'

interface Props {
  session: Session
}

function getToolCallGroups(messages: Session['messages']): ToolCall[][] {
  return messages
    .map(message => message.toolCalls)
    .filter((toolCalls): toolCalls is ToolCall[] => Array.isArray(toolCalls) && toolCalls.length > 0)
}

function TaskStatusPanel({ session }: Props) {
  const t = useT()
  const [expandedPanels, setExpandedPanels] = useState<Record<string, boolean>>({
    tasks: true,
    tools: true,
    files: true,
  })

  const togglePanel = (panel: string) => {
    setExpandedPanels(prev => ({ ...prev, [panel]: !prev[panel] }))
  }

  const allToolCalls = useMemo(() => (
    session.messages
      .filter(message => message.toolCalls && message.toolCalls.length > 0)
      .flatMap(message => message.toolCalls || [])
  ), [session.messages])

  return (
    <div className="w-72 border-l border-border-subtle bg-surface flex flex-col h-full pb-2">
      <CollapsiblePanel
        title={t.chat.tasks}
        count={session.tasks.length}
        icon={<CheckCircle2 className="w-3.5 h-3.5 text-accent" />}
        expanded={expandedPanels.tasks}
        onToggle={() => togglePanel('tasks')}
      >
        <TasksTab tasks={session.tasks} />
      </CollapsiblePanel>

      <CollapsiblePanel
        title={t.chat.tools}
        count={allToolCalls.length}
        icon={<Wrench className="w-3.5 h-3.5 text-text-tertiary" />}
        expanded={expandedPanels.tools}
        onToggle={() => togglePanel('tools')}
      >
        <ToolsTab toolCalls={allToolCalls} />
      </CollapsiblePanel>

      <CollapsiblePanel
        title={t.chat.files}
        count={session.workspaceFiles.length}
        icon={<FolderOpen className="w-3.5 h-3.5 text-text-tertiary" />}
        expanded={expandedPanels.files}
        onToggle={() => togglePanel('files')}
      >
        <FilesTab files={session.workspaceFiles} workspacePath={session.workspacePath} />
      </CollapsiblePanel>
    </div>
  )
}

function CollapsiblePanel({ title, count, icon, expanded, onToggle, children }: {
  title: string
  count: number
  icon: React.ReactNode
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="mx-2 mt-2 rounded-lg border border-border-subtle bg-white flex flex-col flex-initial min-h-0">
      <button
        onClick={onToggle}
        className="h-9 flex-none w-full flex items-center gap-2 px-3 hover:bg-gray-50/80 transition-colors rounded-lg"
      >
        <ChevronRight className={`w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
        {icon}
        <span className="text-xs font-medium text-charcoal">{title}</span>
        {count > 0 && (
          <span className="text-[10px] text-text-tertiary">({count})</span>
        )}
      </button>
      <div className={`grid min-h-0 transition-[grid-template-rows] duration-200 ease-out ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden min-h-0">
          <div className="h-full overflow-y-auto px-3 pt-2.5 pb-3 border-t border-border-subtle">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

function TasksTab({ tasks }: { tasks: TaskItem[] }) {
  const t = useT()
  if (tasks.length === 0) {
    return (
      <p className="text-xs text-text-tertiary text-center py-6">
        {t.chat.noTasks}
      </p>
    )
  }

  return (
    <div className="space-y-1">
      {tasks.map(task => (
        <div key={task.id} className="flex items-start gap-2 py-1.5">
          {task.status === 'completed' ? (
            <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
          ) : task.status === 'in-progress' ? (
            <Loader2 className="w-4 h-4 text-accent animate-spin shrink-0 mt-0.5" />
          ) : (
            <Circle className="w-4 h-4 text-text-tertiary shrink-0 mt-0.5" />
          )}
          <span className={`text-xs leading-relaxed ${
            task.status === 'completed' ? 'text-text-secondary line-through' : 'text-charcoal'
          }`}>
            {task.title}
          </span>
        </div>
      ))}
    </div>
  )
}

function ToolsTab({ toolCalls }: { toolCalls: ToolCall[] }) {
  const t = useT()
  if (toolCalls.length === 0) {
    return (
      <p className="text-xs text-text-tertiary text-center py-6">
        {t.chat.noTools}
      </p>
    )
  }

  return (
    <div className="space-y-1">
      {toolCalls.map((tc, idx) => (
        <ToolCallItem key={`${tc.id}-${idx}`} toolCall={tc} />
      ))}
    </div>
  )
}

function ToolCallItem({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false)

  const getStatusIcon = () => {
    switch (toolCall.status) {
      case 'running': return <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
      case 'completed': return <CheckCircle2 className="w-3.5 h-3.5 text-success" />
      case 'error': return <XCircle className="w-3.5 h-3.5 text-danger" />
      default: return <Wrench className="w-3.5 h-3.5 text-text-tertiary" />
    }
  }

  return (
    <div className="rounded border border-border-light">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {getStatusIcon()}
        <span className="text-[11px] font-medium text-charcoal truncate flex-1">
          {toolCall.name}
        </span>
        {expanded ? (
          <ChevronRight className="w-3 h-3 text-text-tertiary rotate-90 transition-transform duration-200" />
        ) : (
          <ChevronRight className="w-3 h-3 text-text-tertiary transition-transform duration-200" />
        )}
      </button>
      {expanded && toolCall.result && (
        <div className="px-2.5 pb-2 animate-fade-in">
          <pre className="text-[10px] text-text-secondary bg-gray-50 rounded p-2 overflow-x-auto font-mono max-h-32 overflow-y-auto">
            {toolCall.result.substring(0, 500)}
          </pre>
        </div>
      )}
    </div>
  )
}

function FilesTab({ files, workspacePath }: { files: WorkspaceFile[]; workspacePath: string | null }) {
  const t = useT()
  if (!workspacePath) {
    return (
      <div className="text-center py-6">
        <FolderOpen className="w-6 h-6 text-text-tertiary mx-auto mb-2" />
        <p className="text-xs text-text-tertiary">
          {t.chat.noWorkspace}
        </p>
        <p className="text-[10px] text-text-tertiary mt-1">
          {t.chat.selectWorkspace}
        </p>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="text-center py-6">
        <p className="text-xs text-text-tertiary">
          {t.chat.emptyWorkspace}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      <div className="text-[10px] text-text-tertiary mb-2 truncate" title={workspacePath}>
        {workspacePath}
      </div>
      {files.map(file => (
        <div key={file.path} className="flex items-center gap-2 py-1 px-1.5 rounded hover:bg-gray-50 transition-colors">
          {file.type === 'directory' ? (
            <FolderOpen className="w-3.5 h-3.5 text-accent/50 shrink-0" />
          ) : (
            <FileText className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
          )}
          <span className="text-[11px] text-charcoal truncate">{file.name}</span>
          {file.isTemp && (
            <span className="text-[9px] text-warning bg-warning-light px-1 rounded">tmp</span>
          )}
        </div>
      ))}
    </div>
  )
}

export default memo(TaskStatusPanel, (prevProps, nextProps) => {
  if (prevProps.session.tasks !== nextProps.session.tasks) return false
  if (prevProps.session.workspaceFiles !== nextProps.session.workspaceFiles) return false
  if (prevProps.session.workspacePath !== nextProps.session.workspacePath) return false

  const prevToolCallGroups = getToolCallGroups(prevProps.session.messages)
  const nextToolCallGroups = getToolCallGroups(nextProps.session.messages)

  if (prevToolCallGroups.length !== nextToolCallGroups.length) return false

  return prevToolCallGroups.every((toolCalls, index) => toolCalls === nextToolCallGroups[index])
})
