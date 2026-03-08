import { useState, useMemo } from 'react'
import { User, Bot, ChevronDown, ChevronRight, Terminal, CheckCircle2, XCircle, Loader2, Brain } from 'lucide-react'
import type { Message, ToolCall, ContentBlock } from '../../types'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  message: Message
  isLast: boolean
}

export default function MessageBubble({ message, isLast }: Props) {
  const isUser = message.role === 'user'

  return (
    <div className="py-4 animate-fade-in">
      <div className="flex items-start gap-3">
        <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5 ${
          isUser ? 'bg-charcoal/5' : 'bg-accent/10'
        }`}>
          {isUser ? (
            <User className="w-3.5 h-3.5 text-charcoal/50" />
          ) : (
            <Bot className="w-3.5 h-3.5 text-accent" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-charcoal">
              {isUser ? 'You' : 'Agent'}
            </span>
            <span className="text-[10px] text-text-tertiary">
              {new Date(message.timestamp).toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit',
              })}
            </span>
            {message.isStreaming && (
              <Loader2 className="w-3 h-3 animate-spin text-accent" />
            )}
          </div>

          {/* Thinking/Reasoning */}
          {message.thinking && (
            <ThinkingBlock content={message.thinking} isStreaming={message.isStreaming} />
          )}

          {/* Render based on whether we have contentBlocks (new) or not (legacy) */}
          {message.contentBlocks && message.contentBlocks.length > 0 ? (
            <ChronologicalContent
              blocks={message.contentBlocks}
              toolCalls={message.toolCalls}
              isStreaming={message.isStreaming}
            />
          ) : (
            <LegacyContent message={message} />
          )}
        </div>
      </div>
    </div>
  )
}

// Segment types for rendering: text renders inline, tool-groups collapse into summary
interface RenderSegment {
  type: 'text' | 'tool-group'
  blocks: ContentBlock[]
}

// Walk through all contentBlocks and group consecutive tool-calls between text blocks
function segmentBlocks(blocks: ContentBlock[]): RenderSegment[] {
  const segments: RenderSegment[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      segments.push({ type: 'text', blocks: [block] })
    } else if (block.type === 'tool-call') {
      const last = segments[segments.length - 1]
      if (last && last.type === 'tool-group') {
        last.blocks.push(block)
      } else {
        segments.push({ type: 'tool-group', blocks: [block] })
      }
    }
    // Skip 'iteration-end' blocks — not used for rendering
  }
  return segments
}

function ChronologicalContent({ blocks, toolCalls, isStreaming }: {
  blocks: ContentBlock[]
  toolCalls?: ToolCall[]
  isStreaming?: boolean
}) {
  const segments = useMemo(() => segmentBlocks(blocks), [blocks])

  return (
    <div className="space-y-1.5">
      {segments.map((seg, idx) => {
        if (seg.type === 'text') {
          const block = seg.blocks[0]
          return block.content ? (
            <div key={`text-${idx}`} className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {block.content}
              </ReactMarkdown>
            </div>
          ) : null
        }

        // tool-group: check if any tool call is still running
        const resolvedCalls = seg.blocks
          .map(b => toolCalls?.find(t => t.id === b.toolCallId))
          .filter(Boolean) as ToolCall[]

        const hasRunning = resolvedCalls.some(tc => tc.status === 'running' || tc.status === 'pending')

        // If any tool is still running, render individually for live feedback
        if (hasRunning) {
          return (
            <div key={`tg-${idx}`} className="space-y-1.5">
              {resolvedCalls.map(tc => (
                <ToolCallBlock key={tc.id} toolCall={tc} />
              ))}
            </div>
          )
        }

        // All done: collapse into a single summary line
        return (
          <ToolGroupSummary
            key={`tg-${idx}`}
            toolCalls={resolvedCalls}
          />
        )
      })}
    </div>
  )
}

// Single collapsible summary for a group of completed tool calls
function ToolGroupSummary({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [expanded, setExpanded] = useState(false)

  const summary = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const tc of toolCalls) {
      const label = getToolSummaryLabel(tc.name)
      counts[label] = (counts[label] || 0) + 1
    }
    return Object.entries(counts)
      .map(([label, count]) => count > 1 ? `${label} (${count})` : label)
      .join(', ')
  }, [toolCalls])

  if (!summary || toolCalls.length === 0) return null

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-secondary transition-colors py-0.5"
      >
        <span>{summary}</span>
        {expanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
      </button>
      <div className={`iteration-collapse ${expanded ? 'expanded' : 'collapsed'}`}>
        <div className="pt-1.5 space-y-1.5">
          {toolCalls.map(tc => (
            <ToolCallBlock key={tc.id} toolCall={tc} />
          ))}
        </div>
      </div>
    </div>
  )
}

// Legacy rendering for old messages without contentBlocks
function LegacyContent({ message }: { message: Message }) {
  const isUser = message.role === 'user'

  return (
    <>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {message.toolCalls.map(tc => (
            <ToolCallBlock key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
      {message.content && (
        <div className={`${isUser ? 'text-sm text-charcoal' : 'markdown-content'}`}>
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          )}
        </div>
      )}
    </>
  )
}

function getToolSummaryLabel(name: string): string {
  const labels: Record<string, string> = {
    read_file: 'Read file',
    write_file: 'Created file',
    edit_file: 'Edited file',
    delete_file: 'Deleted file',
    list_directory: 'Listed directory',
    search_files: 'Searched files',
    search_content: 'Searched content',
    execute_command: 'Ran command',
    create_task_list: 'Updated tasks',
    web_search: 'Searched the web',
    web_fetch: 'Fetched web page',
  }
  return labels[name] || name
}

function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
      >
        <Brain className="w-3.5 h-3.5" />
        <span>Thinking</span>
        {isStreaming && <Loader2 className="w-3 h-3 animate-spin" />}
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {expanded && (
        <div className="mt-1.5 pl-5 border-l-2 border-border-light animate-fade-in">
          <p className="text-xs text-text-tertiary leading-relaxed whitespace-pre-wrap">
            {content}
          </p>
        </div>
      )}
    </div>
  )
}

function ToolCallBlock({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false)

  const getStatusIcon = () => {
    switch (toolCall.status) {
      case 'running':
        return <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
      case 'completed':
        return <CheckCircle2 className="w-3.5 h-3.5 text-success" />
      case 'error':
        return <XCircle className="w-3.5 h-3.5 text-danger" />
      default:
        return <Terminal className="w-3.5 h-3.5 text-text-tertiary" />
    }
  }

  const getToolLabel = (name: string) => {
    const labels: Record<string, string> = {
      read_file: 'Read File',
      write_file: 'Write File',
      edit_file: 'Edit File',
      delete_file: 'Delete File',
      list_directory: 'List Directory',
      search_files: 'Search Files',
      search_content: 'Search Content',
      execute_command: 'Execute Command',
      create_task_list: 'Task List',
      web_search: 'Web Search',
      web_fetch: 'Fetch Page',
    }
    return labels[name] || name
  }

  const getToolPath = () => {
    try {
      const args = JSON.parse(toolCall.arguments)
      return args.path || args.command || args.directory || args.query || args.url || ''
    } catch {
      return ''
    }
  }

  return (
    <div className={`rounded border transition-all duration-200 ${
      toolCall.status === 'error'
        ? 'border-danger/20 bg-danger-light/50'
        : 'border-border-subtle bg-gray-50/50'
    }`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {getStatusIcon()}
        <span className="text-xs font-medium text-charcoal">
          {getToolLabel(toolCall.name)}
        </span>
        <span className="text-[10px] text-text-tertiary truncate flex-1">
          {getToolPath()}
        </span>
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-text-tertiary shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-text-tertiary shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-2.5 animate-fade-in">
          <div className="mb-2">
            <span className="text-[10px] text-text-tertiary font-medium">Input:</span>
            <pre className="mt-1 text-[11px] text-charcoal bg-white/60 rounded p-2 overflow-x-auto font-mono">
              {formatJSON(toolCall.arguments)}
            </pre>
          </div>
          {toolCall.result && (
            <div>
              <span className="text-[10px] text-text-tertiary font-medium">Output:</span>
              <pre className="mt-1 text-[11px] bg-terminal text-gray-200 rounded p-2 overflow-x-auto font-mono max-h-48 overflow-y-auto">
                {toolCall.result}
              </pre>
            </div>
          )}
          {toolCall.error && (
            <div>
              <span className="text-[10px] text-danger font-medium">Error:</span>
              <pre className="mt-1 text-[11px] text-danger bg-danger-light rounded p-2 overflow-x-auto font-mono">
                {toolCall.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatJSON(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2)
  } catch {
    return str
  }
}
