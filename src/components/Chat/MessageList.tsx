import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Message } from '../../types'
import { useT } from '../../i18n'
import MessageBubble from './MessageBubble'
import { Loader2, Zap, ArrowDown } from 'lucide-react'

interface Props {
  messages: Message[]
  isRunning: boolean
  sessionId: string
}

export default function MessageList({ messages, isRunning, sessionId }: Props) {
  const t = useT()
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isAutoScrollRef = useRef(true)
  const previousMessageCountRef = useRef(0)
  const previousLastMessageIdRef = useRef<string | null>(null)
  const prevSessionIdRef = useRef(sessionId)
  const [showScrollButton, setShowScrollButton] = useState(false)

  const lastMessage = messages[messages.length - 1]
  const lastMessageSignature = lastMessage
    ? `${lastMessage.id}:${lastMessage.content.length}:${lastMessage.thinking?.length || 0}:${lastMessage.toolCalls?.length || 0}:${lastMessage.contentBlocks?.length || 0}:${lastMessage.isStreaming ? 1 : 0}`
    : 'empty'

  // Initial mount — instant scroll to bottom before paint
  useLayoutEffect(() => {
    const container = containerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [])

  // Session switch — instant scroll to bottom before paint
  useLayoutEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId
      isAutoScrollRef.current = true
      setShowScrollButton(false)
      previousMessageCountRef.current = messages.length
      previousLastMessageIdRef.current = lastMessage?.id || null
      const container = containerRef.current
      if (container) {
        container.scrollTop = container.scrollHeight
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Smooth auto-scroll during streaming / new messages
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
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100
    isAutoScrollRef.current = isNearBottom
    setShowScrollButton(prev => {
      const shouldShow = !isNearBottom
      return prev === shouldShow ? prev : shouldShow
    })
  }

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    isAutoScrollRef.current = true
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="text-center max-w-sm">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-accent/5 rounded-xl mb-4">
            <Zap className="w-7 h-7 text-accent/40" strokeWidth={1.5} />
          </div>
          <h3 className="text-base font-medium text-charcoal mb-2">
            {t.chat.whatCanIHelp}
          </h3>
          <p className="text-sm text-text-tertiary leading-relaxed">
            {t.chat.helpDescription}
          </p>
          <div className="flex flex-wrap gap-2 justify-center mt-5">
            {[
              t.chat.suggestion1,
              t.chat.suggestion2,
              t.chat.suggestion3,
              t.chat.suggestion4,
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
    <div className="flex-1 min-h-0 relative">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto pb-4"
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
              <span className="text-xs">{t.chat.thinking}</span>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      <div className={`absolute bottom-3 left-0 right-0 flex justify-center pointer-events-none transition-all duration-200 ${
        showScrollButton ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}>
        <button
          onClick={scrollToBottom}
          className="pointer-events-auto bg-white/80 backdrop-blur-sm border border-border-subtle rounded-full p-2 shadow-sm hover:shadow hover:bg-white transition-all duration-200 text-text-secondary hover:text-charcoal"
          tabIndex={showScrollButton ? 0 : -1}
          aria-label={t.chat.scrollToBottom}
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
