import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { User, Bot, ChevronRight, Terminal, CheckCircle2, XCircle, Loader2, Brain, FileText, Search, Globe, ListTodo } from 'lucide-react'
import type { Message, ToolCall, ContentBlock } from '../../types'
import { useT } from '../../i18n'
import type { Translations } from '../../i18n/zh'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  message: Message
  isLast: boolean
}

interface RenderSegment {
  type: 'text' | 'tool-group'
  blocks: ContentBlock[]
  hasIterationEndAfter?: boolean
}

const MARKDOWN_PLUGINS = [remarkGfm]

function segmentBlocks(blocks: ContentBlock[]): RenderSegment[] {
  const segments: RenderSegment[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      segments.push({ type: 'text', blocks: [block] })
      continue
    }

    if (block.type === 'iteration-end') {
      // Mark the last tool-group as having an iteration-end after it
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].type === 'tool-group') {
          segments[i].hasIterationEndAfter = true
          break
        }
      }
      // iteration-end also breaks consecutive tool-call grouping
      // (next tool-call block will start a new group)
      segments.push({ type: 'text', blocks: [] })
      continue
    }

    if (block.type === 'tool-call') {
      const lastSegment = segments[segments.length - 1]
      if (lastSegment && lastSegment.type === 'tool-group') {
        lastSegment.blocks.push(block)
      } else {
        segments.push({ type: 'tool-group', blocks: [block] })
      }
    }
  }

  // Remove empty placeholder segments used for breaking groups
  return segments.filter(s => s.blocks.length > 0 || s.type === 'tool-group')
}

const MessageBubble = memo(function MessageBubble({ message }: Props) {
  const t = useT()
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
              {isUser ? t.chat.you : t.chat.agent}
            </span>
            <span className="text-[10px] text-text-tertiary">
              {new Date(message.timestamp).toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit',
              })}
            </span>
            <span className="inline-flex w-3 h-3 items-center justify-center shrink-0">
              {message.isStreaming ? (
                <Loader2 className="w-3 h-3 animate-spin text-accent" />
              ) : null}
            </span>
          </div>

          {(message.thinkingStatus === 'thinking' || !!message.thinking) && (
            <ThinkingBlock content={message.thinking || ''} isThinking={message.thinkingStatus === 'thinking'} />
          )}

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
}, (prevProps, nextProps) => prevProps.message === nextProps.message)

const MarkdownText = memo(function MarkdownText({ content, isStreaming }: {
  content: string
  isStreaming?: boolean
}) {
  const deferredContent = useDeferredValue(content)
  const renderedContent = isStreaming ? (deferredContent || content) : content

  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>
        {renderedContent}
      </ReactMarkdown>
    </div>
  )
})

function ChronologicalContent({ blocks, toolCalls, isStreaming }: {
  blocks: ContentBlock[]
  toolCalls?: ToolCall[]
  isStreaming?: boolean
}) {
  const segments = useMemo(() => segmentBlocks(blocks), [blocks])
  const toolCallMap = useMemo(() => {
    return new Map((toolCalls || []).map(toolCall => [toolCall.id, toolCall]))
  }, [toolCalls])

  return (
    <div className="space-y-1.5">
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          const block = segment.blocks[0]
          if (!block.content) return null

          return (
            <MarkdownText
              key={`text-${index}`}
              content={block.content}
              isStreaming={isStreaming}
            />
          )
        }

        const resolvedCalls = segment.blocks
          .map(block => block.toolCallId ? toolCallMap.get(block.toolCallId) : undefined)
          .filter(Boolean) as ToolCall[]

        if (resolvedCalls.length === 0) return null

        return (
          <ToolGroup key={`tg-${index}`} toolCalls={resolvedCalls} isActive={!!isStreaming && !segment.hasIterationEndAfter} />
        )
      })}
    </div>
  )
}

function ToolGroup({ toolCalls, isActive }: { toolCalls: ToolCall[]; isActive: boolean }) {
  const t = useT()
  const [manualOverride, setManualOverride] = useState<boolean | null>(null)
  const hasRunning = toolCalls.some(toolCall => toolCall.status === 'running' || toolCall.status === 'pending')
  const hasError = !hasRunning && toolCalls.some(toolCall => toolCall.status === 'error')

  // Track previous running state to detect completion transition
  const prevHasRunning = useRef(hasRunning)
  useEffect(() => {
    if (prevHasRunning.current && !hasRunning) {
      // Running → completed: auto-collapse
      setManualOverride(null)
    }
    prevHasRunning.current = hasRunning
  }, [hasRunning])

  // Auto-expand when running (unless user manually collapsed)
  const expanded = manualOverride !== null ? manualOverride : hasRunning

  const summary = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const toolCall of toolCalls) {
      const label = getToolSummaryLabel(toolCall.name, t)
      counts[label] = (counts[label] || 0) + 1
    }
    return Object.entries(counts)
      .map(([label, count]) => count > 1 ? `${label} (${count})` : label)
      .join(', ')
  }, [toolCalls, t])

  if (!summary || toolCalls.length === 0) return null

  return (
    <div>
      <button
        onClick={() => setManualOverride(prev => prev !== null ? !prev : !expanded)}
        className="w-full flex items-center gap-1.5 px-1 py-1.5 text-left"
      >
        {hasRunning ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-accent shrink-0" />
        ) : hasError ? (
          <XCircle className="w-3.5 h-3.5 text-danger shrink-0" />
        ) : (
          <CheckCircle2 className="w-3.5 h-3.5 text-success/60 shrink-0" />
        )}
        <span className={`text-xs truncate ${
          hasRunning ? 'text-text-secondary' : hasError ? 'text-danger' : 'text-text-tertiary'
        }`}>
          {hasRunning ? t.chat.running : summary}
        </span>
        {hasRunning && (
          <span className="text-[10px] text-accent bg-accent/10 px-1.5 py-0.5 rounded-full shrink-0">{t.chat.inProgress}</span>
        )}
        <ChevronRight className={`w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
      </button>
      <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden min-h-0">
          <div className="px-1 pb-2 space-y-1.5">
            {toolCalls.map(toolCall => (
              <ToolCallBlock key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function LegacyContent({ message }: { message: Message }) {
  const isUser = message.role === 'user'

  return (
    <>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {message.toolCalls.map(toolCall => (
            <ToolCallBlock key={toolCall.id} toolCall={toolCall} />
          ))}
        </div>
      )}
      {message.content && (
        isUser ? (
          <div className="text-sm text-charcoal whitespace-pre-wrap leading-relaxed">
            {message.content}
          </div>
        ) : (
          <MarkdownText content={message.content} isStreaming={message.isStreaming} />
        )
      )}
    </>
  )
}

function getToolSummaryLabel(name: string, t: Translations): string {
  const labels: Record<string, string> = {
    read_file: t.chat.toolReadFile,
    write_file: t.chat.toolWriteFile,
    edit_file: t.chat.toolEditFile,
    delete_file: t.chat.toolDeleteFile,
    list_directory: t.chat.toolListDir,
    search_files: t.chat.toolSearchFiles,
    search_content: t.chat.toolSearchContent,
    execute_command: t.chat.toolExecCommand,
    create_task_list: t.chat.toolTaskList,
    web_search: t.chat.toolWebSearch,
    web_fetch: t.chat.toolFetchPage,
  }
  return labels[name] || name
}

function ThinkingBlock({ content, isThinking }: { content: string; isThinking: boolean }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const hasContent = content.trim().length > 0

  return (
    <div className="mb-3">
      <button
        onClick={() => {
          if (!hasContent) return
          setExpanded(prev => !prev)
        }}
        disabled={!hasContent}
        className={`flex items-center gap-1.5 text-xs transition-colors ${
          hasContent
            ? 'text-text-tertiary hover:text-text-secondary'
            : 'text-text-tertiary cursor-default'
        }`}
      >
        <Brain className="w-3.5 h-3.5 shrink-0" />
        <span>{isThinking ? t.chat.thinking : t.chat.thinkingDone}</span>
        <span className="inline-flex w-3 h-3 items-center justify-center shrink-0">
          {isThinking ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
        </span>
        <span className="inline-flex w-3 h-3 items-center justify-center shrink-0">
          {hasContent ? (
            <ChevronRight className={`w-3 h-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
          ) : null}
        </span>
      </button>
      <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden min-h-0">
          {hasContent && (
            <div className="mt-1.5 pl-5 border-l-2 border-border-light">
              <p className="text-xs text-text-tertiary leading-relaxed whitespace-pre-wrap">
                {content}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const ToolCallBlock = memo(function ToolCallBlock({ toolCall }: { toolCall: ToolCall }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)

  const toolPath = useMemo(() => {
    try {
      const args = JSON.parse(toolCall.arguments)
      return args.path || args.command || args.directory || args.query || args.url || ''
    } catch {
      return ''
    }
  }, [toolCall.arguments])

  const statusIcon = (() => {
    switch (toolCall.status) {
      case 'running':
        return <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
      case 'completed':
        return <CheckCircle2 className="w-3.5 h-3.5 text-success" />
      case 'error':
        return <XCircle className="w-3.5 h-3.5 text-danger" />
      default:
        return getToolCategoryIcon(toolCall.name)
    }
  })()

  return (
    <div className={`rounded border transition-colors duration-200 ${
      toolCall.status === 'error'
        ? 'border-danger/20 bg-danger-light/50'
        : 'border-border-subtle bg-gray-50/50'
    }`}>
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {statusIcon}
        <span className="text-xs font-medium text-charcoal">
          {getToolLabel(toolCall.name, t)}
        </span>
        <span className="text-[10px] text-text-tertiary truncate flex-1">
          {toolPath}
        </span>
        <ChevronRight className={`w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
      </button>
      <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden min-h-0">
          <div className="px-3 pb-2.5">
            <div className="mb-2">
              <span className="text-[10px] text-text-tertiary font-medium">{t.chat.input}</span>
              <pre className="mt-1 text-[11px] text-charcoal bg-white/60 rounded p-2 overflow-x-auto font-mono">
                {formatJSON(toolCall.arguments)}
              </pre>
            </div>
            {toolCall.result && (
              <div>
                <span className="text-[10px] text-text-tertiary font-medium">{t.chat.output}</span>
                <pre className="mt-1 text-[11px] bg-terminal text-gray-200 rounded p-2 overflow-x-auto font-mono max-h-48 overflow-y-auto">
                  {toolCall.result}
                </pre>
              </div>
            )}
            {toolCall.error && (
              <div>
                <span className="text-[10px] text-danger font-medium">{t.chat.error}</span>
                <pre className="mt-1 text-[11px] text-danger bg-danger-light rounded p-2 overflow-x-auto font-mono">
                  {toolCall.error}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

function getToolLabel(name: string, t: Translations) {
  const labels: Record<string, string> = {
    read_file: t.chat.toolReadFile,
    write_file: t.chat.toolWriteFile,
    edit_file: t.chat.toolEditFile,
    delete_file: t.chat.toolDeleteFile,
    list_directory: t.chat.toolListDir,
    search_files: t.chat.toolSearchFiles,
    search_content: t.chat.toolSearchContent,
    execute_command: t.chat.toolExecCommand,
    create_task_list: t.chat.toolTaskList,
    web_search: t.chat.toolWebSearch,
    web_fetch: t.chat.toolFetchPage,
  }
  return labels[name] || name
}

function formatJSON(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2)
  } catch {
    return str
  }
}

function getToolCategoryIcon(name: string) {
  const fileTools = ['read_file', 'write_file', 'edit_file', 'delete_file']
  const searchTools = ['list_directory', 'search_files', 'search_content']
  const webTools = ['web_search', 'web_fetch']

  if (fileTools.includes(name)) return <FileText className="w-3.5 h-3.5 text-text-tertiary" />
  if (searchTools.includes(name)) return <Search className="w-3.5 h-3.5 text-text-tertiary" />
  if (webTools.includes(name)) return <Globe className="w-3.5 h-3.5 text-text-tertiary" />
  if (name === 'create_task_list') return <ListTodo className="w-3.5 h-3.5 text-text-tertiary" />
  return <Terminal className="w-3.5 h-3.5 text-text-tertiary" />
}

export default MessageBubble
