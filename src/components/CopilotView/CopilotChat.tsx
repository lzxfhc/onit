import { useCallback, useMemo } from 'react'
import { v4 as uuidv4 } from 'uuid'
import MessageList from '../Chat/MessageList'
import CopilotInputBox from './CopilotInputBox'
import { useCopilotStore } from '../../stores/copilotStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useT } from '../../i18n'
import type { Message } from '../../types'

export default function CopilotChat() {
  const t = useT()
  const messages = useCopilotStore(s => s.messages)
  const isRunning = useCopilotStore(s => s.isRunning)

  const handleSend = useCallback(async (content: string) => {
    const trimmed = content.trim()
    if (!trimmed) return

    const copilotStore = useCopilotStore.getState()
    const settingsStore = useSettingsStore.getState()

    if (copilotStore.isRunning) return

    const runId = `copilot-${uuidv4()}`
    const now = Date.now()

    const userMsg: Message = {
      id: uuidv4(),
      role: 'user',
      content: trimmed,
      timestamp: now,
    }

    const assistantMsg: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: now,
      isStreaming: true,
      toolCalls: [],
      contentBlocks: [],
      runId,
    }

    copilotStore.startRun(userMsg, assistantMsg, runId)

    try {
      // Time-gap-aware context trimming:
      // Recent → full context. Long gap → trimmed (SessionMemory covers the rest).
      const allMessages = copilotStore.messages
      const lastMsgTime = allMessages.length > 0
        ? allMessages[allMessages.length - 1].timestamp
        : 0
      const gapMs = Date.now() - lastMsgTime

      let prevMessages = allMessages
      if (gapMs > 4 * 60 * 60 * 1000) {
        // > 4 hours: near-fresh start, rely on SessionMemory for history
        prevMessages = allMessages.slice(-4)
      } else if (gapMs > 30 * 60 * 1000) {
        // 30 min ~ 4 hours: moderate trim
        prevMessages = allMessages.slice(-20)
      }

      await window.electronAPI.startCopilot({
        message: trimmed,
        runId,
        apiConfig: settingsStore.settings.apiConfig,
        messages: prevMessages,
      })
    } catch (err: any) {
      copilotStore.completeRun(runId, 'error')
      copilotStore.addMessage({
        id: uuidv4(),
        role: 'assistant',
        content: `Failed to start copilot: ${err.message}`,
        timestamp: Date.now(),
        runId,
      })
      copilotStore.saveCopilotData()
    }
  }, [])

  const handleStop = useCallback(async () => {
    const copilotStore = useCopilotStore.getState()
    if (!copilotStore.activeRunId) return

    const runId = copilotStore.activeRunId

    try {
      await window.electronAPI.stopCopilot()
    } finally {
      copilotStore.completeRun(runId, 'stopped')
      copilotStore.saveCopilotData()
    }
  }, [])

  // Show greeting when conversation is empty (memoized to avoid re-render)
  const greetingMessage = useMemo<Message[]>(() => [{
    id: 'greeting',
    role: 'assistant' as const,
    content: t.copilot.greeting,
    timestamp: Date.now(),
  }], [t.copilot.greeting])

  const displayMessages = messages.length > 0 ? messages : greetingMessage

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <MessageList
        messages={displayMessages}
        isRunning={isRunning}
        sessionId="copilot-main"
      />
      <CopilotInputBox
        onSend={handleSend}
        onStop={handleStop}
        isRunning={isRunning}
      />
    </div>
  )
}
