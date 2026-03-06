import { useState } from 'react'
import {
  CheckCircle2, Circle, Loader2, Terminal, FileText,
  FolderOpen, ChevronDown, ChevronRight, XCircle
} from 'lucide-react'
import type { Session, TaskItem, ToolCall, WorkspaceFile } from '../../types'

interface Props {
  session: Session
}

type PanelTab = 'tasks' | 'tools' | 'files'

export default function TaskStatusPanel({ session }: Props) {
  const [activeTab, setActiveTab] = useState<PanelTab>('tasks')

  // Collect all tool calls from messages
  const allToolCalls = session.messages
    .filter(m => m.toolCalls && m.toolCalls.length > 0)
    .flatMap(m => m.toolCalls || [])

  const tabCounts = {
    tasks: session.tasks.length,
    tools: allToolCalls.length,
    files: session.workspaceFiles.length,
  }

  return (
    <div className="w-72 border-l border-border-subtle bg-surface flex flex-col h-full pt-14">
      {/* Tabs */}
      <div className="flex border-b border-border-subtle">
        <PanelTabButton
          active={activeTab === 'tasks'}
          onClick={() => setActiveTab('tasks')}
          label="Tasks"
          count={tabCounts.tasks}
        />
        <PanelTabButton
          active={activeTab === 'tools'}
          onClick={() => setActiveTab('tools')}
          label="Tools"
          count={tabCounts.tools}
        />
        <PanelTabButton
          active={activeTab === 'files'}
          onClick={() => setActiveTab('files')}
          label="Files"
          count={tabCounts.files}
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {activeTab === 'tasks' && <TasksTab tasks={session.tasks} />}
        {activeTab === 'tools' && <ToolsTab toolCalls={allToolCalls} />}
        {activeTab === 'files' && <FilesTab files={session.workspaceFiles} workspacePath={session.workspacePath} />}
      </div>
    </div>
  )
}

function PanelTabButton({ active, onClick, label, count }: {
  active: boolean
  onClick: () => void
  label: string
  count: number
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 text-xs font-medium transition-all border-b-2 ${
        active
          ? 'border-accent text-accent-700'
          : 'border-transparent text-text-tertiary hover:text-text-secondary'
      }`}
    >
      {label}
      {count > 0 && (
        <span className={`ml-1 text-[10px] ${active ? 'text-accent' : 'text-text-tertiary'}`}>
          ({count})
        </span>
      )}
    </button>
  )
}

function TasksTab({ tasks }: { tasks: TaskItem[] }) {
  if (tasks.length === 0) {
    return (
      <p className="text-xs text-text-tertiary text-center py-6">
        No tasks yet. The agent will create tasks when working on complex operations.
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
  if (toolCalls.length === 0) {
    return (
      <p className="text-xs text-text-tertiary text-center py-6">
        No tools called yet.
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
      default: return <Terminal className="w-3.5 h-3.5 text-text-tertiary" />
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
          <ChevronDown className="w-3 h-3 text-text-tertiary" />
        ) : (
          <ChevronRight className="w-3 h-3 text-text-tertiary" />
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
  if (!workspacePath) {
    return (
      <div className="text-center py-6">
        <FolderOpen className="w-6 h-6 text-text-tertiary mx-auto mb-2" />
        <p className="text-xs text-text-tertiary">
          No workspace selected.
        </p>
        <p className="text-[10px] text-text-tertiary mt-1">
          Select a workspace folder to see files here.
        </p>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="text-center py-6">
        <p className="text-xs text-text-tertiary">
          Workspace is empty.
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
