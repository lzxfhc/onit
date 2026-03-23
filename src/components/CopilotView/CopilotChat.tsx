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

    // Allow sending even if running — InputBox handles stop-then-send

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

    // Capture conversation history BEFORE startRun modifies the messages array
    const prevMessages = [...copilotStore.messages]

    copilotStore.startRun(userMsg, assistantMsg, runId)

    try {
      await window.electronAPI.startCopilot({
        message: trimmed,
        runId,
        apiConfig: settingsStore.settings.apiConfig,
        messages: prevMessages,
      })
    } catch (err: any) {
      // IPC call itself failed — update the streaming assistant message with error
      useCopilotStore.getState().completeRun(runId, 'error')
      useCopilotStore.getState().saveCopilotData()
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

  // Show greeting when conversation is empty (stable reference to avoid re-renders)
  const greetingMsg = useMemo(() => [{
    id: 'greeting',
    role: 'assistant' as const,
    content: t.copilot.greeting,
    timestamp: 0,
  }], [t.copilot.greeting])

  const displayMessages = messages.length > 0 ? messages : greetingMsg

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
