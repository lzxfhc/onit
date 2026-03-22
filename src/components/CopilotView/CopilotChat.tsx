import { useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'
import MessageList from '../Chat/MessageList'
import CopilotInputBox from './CopilotInputBox'
import { useCopilotStore } from '../../stores/copilotStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { Message } from '../../types'

export default function CopilotChat() {
  const messages = useCopilotStore(s => s.messages)
  const isRunning = useCopilotStore(s => s.isRunning)

  const handleSend = useCallback(async (content: string) => {
    const trimmed = content.trim()
    if (!trimmed) return

    const copilotStore = useCopilotStore.getState()
    const settingsStore = useSettingsStore.getState()

    if (copilotStore.isRunning) return

    const runId = uuidv4()
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
      await window.electronAPI.startCopilot({
        message: trimmed,
        runId,
        apiConfig: settingsStore.settings.apiConfig,
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

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <MessageList
        messages={messages}
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
