import { useCallback } from 'react'
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
      // Pass conversation history so the orchestrator has context
      const prevMessages = copilotStore.messages.slice(0, -2) // exclude the just-added user+assistant msgs
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
    }
  }, [])

  // Show greeting when conversation is empty
  const displayMessages = messages.length > 0 ? messages : [{
    id: 'greeting',
    role: 'assistant' as const,
    content: t.copilot.greeting,
    timestamp: Date.now(),
  }]

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
