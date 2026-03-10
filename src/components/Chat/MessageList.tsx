import { useEffect, useRef } from 'react'
import type { Message } from '../../types'
import MessageBubble from './MessageBubble'
import { Loader2, Zap } from 'lucide-react'

interface Props {
  messages: Message[]
  isRunning: boolean
}

export default function MessageList({ messages, isRunning }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isAutoScrollRef = useRef(true)
  const previousMessageCountRef = useRef(0)
  const previousLastMessageIdRef = useRef<string | null>(null)

  const lastMessage = messages[messages.length - 1]
  const lastMessageSignature = lastMessage
    ? `${lastMessage.id}:${lastMessage.content.length}:${lastMessage.thinking?.length || 0}:${lastMessage.toolCalls?.length || 0}:${lastMessage.contentBlocks?.length || 0}:${lastMessage.isStreaming ? 1 : 0}`
    : 'empty'

  useEffect(() => {
    const container = containerRef.current
    if (!container || !isAutoScrollRef.current) {
      previousMessageCountRef.current = messages.length
      previousLastMessageIdRef.current = lastMessage?.id || null
      return
    }

    const hasNewMessage =
      previousMessageCountRef.current !== messages.length ||
      previousLastMessageIdRef.current !== (lastMessage?.id || null)

    if (hasNewMessage) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    } else {
      container.scrollTop = container.scrollHeight
    }

    previousMessageCountRef.current = messages.length
    previousLastMessageIdRef.current = lastMessage?.id || null
  }, [messages.length, lastMessageSignature])

  const handleScroll = () => {
    const container = containerRef.current
    if (!container) return
    const { scrollTop, scrollHeight, clientHeight } = container
    isAutoScrollRef.current = scrollHeight - scrollTop - clientHeight < 100
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="text-center max-w-sm">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-accent/5 rounded-xl mb-4">
            <Zap className="w-7 h-7 text-accent/40" strokeWidth={1.5} />
          </div>
          <h3 className="text-base font-medium text-charcoal mb-2">
            What can I help you with?
          </h3>
          <p className="text-sm text-text-tertiary leading-relaxed">
            I can help you with file management, code tasks, data analysis, and more.
            Just describe what you need.
          </p>
          <div className="flex flex-wrap gap-2 justify-center mt-5">
            {[
              'Organize my downloads folder',
              'Help me write a Python script',
              'Summarize this document',
              'Find large files on disk',
            ].map((suggestion) => (
              <span key={suggestion} className="badge-blue text-[10px] cursor-pointer hover:bg-accent-100 transition-colors duration-200 select-none">
                {suggestion}
              </span>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto pt-14 pb-4"
    >
      <div className="max-w-3xl mx-auto px-6">
        {messages.map((message, idx) => (
          <MessageBubble
            key={message.id}
            message={message}
            isLast={idx === messages.length - 1}
          />
        ))}

        {isRunning && lastMessage?.isStreaming &&
          lastMessage.content === '' &&
          !lastMessage.thinking && (
          <div className="flex items-center gap-2 py-3 text-text-tertiary animate-fade-in">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs">Thinking...</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  )
}
