import React, { useCallback, useEffect, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useT } from '../../i18n'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import MessageList from './MessageList'
import InputBox from './InputBox'
import TaskStatusPanel from './TaskStatus'
import type { Message, StreamChunk, PermissionRequest } from '../../types'

function isCurrentRun(sessionId: string, runId?: string) {
  if (!runId) return false
  const session = useSessionStore.getState().sessions.find(s => s.id === sessionId)
  return session?.activeRunId === runId
}

function getRunKey(sessionId: string, runId: string) {
  return `${sessionId}:${runId}`
}

interface PendingStreamChunks {
  sessionId: string
  runId: string
  chunks: StreamChunk[]
}

export default function ChatView({ rightPanelOpen }: { rightPanelOpen: boolean }) {
  const t = useT()
  const activeSession = useSessionStore(state =>
    state.sessions.find(session => session.id === state.activeSessionId) || null,
  )
  const pendingStreamChunksRef = useRef<Map<string, PendingStreamChunks>>(new Map())
  const pendingAnimationFrameRef = useRef<number | null>(null)

  const flushPendingStreamChunks = useCallback((targetKey?: string) => {
    const pending = pendingStreamChunksRef.current
    const sessionStore = useSessionStore.getState()
    const targets = targetKey
      ? (() => {
          const entry = pending.get(targetKey)
          return entry ? [[targetKey, entry] as const] : []
        })()
      : Array.from(pending.entries())

    for (const [key, payload] of targets) {
      pending.delete(key)
      if (payload.chunks.length > 0) {
        sessionStore.applyStreamChunks(payload.sessionId, payload.runId, payload.chunks)
      }
    }
  }, [])

  const schedulePendingStreamFlush = useCallback(() => {
    if (pendingAnimationFrameRef.current !== null) return

    pendingAnimationFrameRef.current = window.requestAnimationFrame(() => {
      pendingAnimationFrameRef.current = null
      flushPendingStreamChunks()
    })
  }, [flushPendingStreamChunks])

  useEffect(() => {
    const flushRun = (sessionId: string, runId: string) => {
      flushPendingStreamChunks(getRunKey(sessionId, runId))
    }

    const unsubStream = window.electronAPI.onAgentStream((data: any) => {
      const { sessionId, runId, chunk } = data
      const key = getRunKey(sessionId, runId)
      const existing = pendingStreamChunksRef.current.get(key)

      if (existing) {
        existing.chunks.push(chunk)
      } else {
        pendingStreamChunksRef.current.set(key, {
          sessionId,
          runId,
          chunks: [chunk],
        })
      }

      schedulePendingStreamFlush()
    })

    const unsubComplete = window.electronAPI.onAgentComplete((data: any) => {
      const { sessionId, runId, status } = data
      flushRun(sessionId, runId)
      useSessionStore.getState().completeRun(sessionId, runId, status)
      useSettingsStore.getState().removePermissionRequestsForSession(sessionId, runId)
      useSessionStore.getState().saveSession(sessionId)
    })

    const unsubError = window.electronAPI.onAgentError((data: any) => {
      const { sessionId, runId, error } = data
      flushRun(sessionId, runId)

      const sessionStore = useSessionStore.getState()
      const session = sessionStore.sessions.find(s => s.id === sessionId)
      const lastMessage = session?.messages[session.messages.length - 1]
      const belongsToCurrentRun = session?.activeRunId === runId || lastMessage?.runId === runId

      if (!belongsToCurrentRun) return

      sessionStore.completeRun(sessionId, runId, 'error')
      useSettingsStore.getState().removePermissionRequestsForSession(sessionId, runId)

      // If the last assistant message for this run is empty, update it in place
      if (lastMessage?.role === 'assistant' && lastMessage.runId === runId && !lastMessage.content?.trim()) {
        sessionStore.updateLastMessage(sessionId, {
          content: `Error: ${error}`,
          isStreaming: false,
        })
      } else {
        const errorMsg: Message = {
          id: uuidv4(),
          role: 'assistant',
          content: `Error: ${error}`,
          timestamp: Date.now(),
          runId,
        }
        sessionStore.addMessage(sessionId, errorMsg)
      }
      sessionStore.saveSession(sessionId)
    })

    const unsubMemoryUpdate = window.electronAPI.onAgentMemoryUpdate((data: any) => {
      const { sessionId, runId, memory } = data
      flushRun(sessionId, runId)

      const sessionStore = useSessionStore.getState()
      const session = sessionStore.sessions.find(s => s.id === sessionId)
      // Memory updates are associated with a specific run. Ignore stale events.
      if (session?.activeRunId && runId && session.activeRunId !== runId) return

      sessionStore.updateSession(sessionId, { sessionMemory: memory })
      sessionStore.saveSession(sessionId)
    })

    const unsubSessionUpdate = window.electronAPI.onAgentSessionUpdate((data: any) => {
      const { sessionId, runId, updates } = data
      flushRun(sessionId, runId)

      const sessionStore = useSessionStore.getState()
      const session = sessionStore.sessions.find(s => s.id === sessionId)
      if (session?.activeRunId && runId && session.activeRunId !== runId) return

      sessionStore.updateSession(sessionId, updates)
      sessionStore.saveSession(sessionId)
    })

    const unsubPermission = window.electronAPI.onPermissionRequest((data: any) => {
      if (!isCurrentRun(data.sessionId, data.runId)) return
      useSettingsStore.getState().addPermissionRequest(data)
    })

    const unsubTaskUpdate = window.electronAPI.onTaskUpdate((data: any) => {
      if (!isCurrentRun(data.sessionId, data.runId)) return
      useSessionStore.getState().updateTasks(data.sessionId, data.tasks)
    })

    const unsubWorkspaceFiles = window.electronAPI.onWorkspaceFiles((data: any) => {
      if (!isCurrentRun(data.sessionId, data.runId)) return
      useSessionStore.getState().updateWorkspaceFiles(data.sessionId, data.files)
    })

    return () => {
      if (pendingAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingAnimationFrameRef.current)
        pendingAnimationFrameRef.current = null
      }
      flushPendingStreamChunks()
      unsubStream()
      unsubComplete()
      unsubError()
      unsubMemoryUpdate()
      unsubSessionUpdate()
      unsubPermission()
      unsubTaskUpdate()
      unsubWorkspaceFiles()
    }
  }, [flushPendingStreamChunks, schedulePendingStreamFlush])

  const handleSendMessage = useCallback(async (content: string) => {
    const trimmedContent = content.trim()
    if (!trimmedContent) return

    const sessionStore = useSessionStore.getState()
    const settingsStore = useSettingsStore.getState()
    const activeSessionId = sessionStore.activeSessionId

    if (!activeSessionId) return

    const latestSession = sessionStore.sessions.find(session => session.id === activeSessionId)
    if (!latestSession) return

    const runId = uuidv4()
    const now = Date.now()

    const userMsg: Message = {
      id: uuidv4(),
      role: 'user',
      content: trimmedContent,
      timestamp: now,
    }

    const assistantMsg: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: now,
      thinkingStatus: 'thinking',
      isStreaming: true,
      toolCalls: [],
      contentBlocks: [],
      runId,
    }

    sessionStore.startAssistantRun(latestSession.id, userMsg, assistantMsg, runId)
    settingsStore.removePermissionRequestsForSession(latestSession.id)

    if (latestSession.messages.length === 0) {
      const name = trimmedContent.substring(0, 40) + (trimmedContent.length > 40 ? '...' : '')
      sessionStore.updateSession(latestSession.id, { name })
    }

    try {
      await window.electronAPI.startAgent({
        sessionId: latestSession.id,
        message: trimmedContent,
        runId,
        session: {
          ...latestSession,
          activeRunId: runId,
          apiConfig: settingsStore.settings.apiConfig,
        },
      })
    } catch (err: any) {
      sessionStore.completeRun(latestSession.id, runId, 'error')
      settingsStore.removePermissionRequestsForSession(latestSession.id, runId)
      sessionStore.addMessage(latestSession.id, {
        id: uuidv4(),
        role: 'assistant',
        content: `Failed to start agent: ${err.message}`,
        timestamp: Date.now(),
        runId,
      })
    }
  }, [])

  const handleStopAgent = useCallback(async () => {
    const sessionStore = useSessionStore.getState()
    const settingsStore = useSettingsStore.getState()
    const activeSessionId = sessionStore.activeSessionId

    if (!activeSessionId) return

    const session = sessionStore.sessions.find(item => item.id === activeSessionId)
    if (!session?.activeRunId) return

    const runId = session.activeRunId

    try {
      await window.electronAPI.stopAgent({ sessionId: session.id })
    } finally {
      sessionStore.completeRun(session.id, runId, 'stopped')
      settingsStore.removePermissionRequestsForSession(session.id, runId)
    }
  }, [])

  if (!activeSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
        {t.chat.selectSession}
      </div>
    )
  }

  return (
    <div className="flex-1 flex min-h-0">
      <div className="flex-1 flex flex-col min-w-0 relative">
        <MessageList
          messages={activeSession.messages}
          isRunning={activeSession.status === 'running'}
          sessionId={activeSession.id}
        />
        {/* Inline question/plan cards — above the input box */}
        <InlineInteractiveCards sessionId={activeSession.id} />
        <InputBox
          onSend={handleSendMessage}
          onStop={handleStopAgent}
          isRunning={activeSession.status === 'running'}
          sessionId={activeSession.id}
        />
      </div>

      <div
        className={`shrink-0 transition-[width] duration-200 ease-out overflow-hidden ${
          rightPanelOpen ? 'w-72' : 'w-0'
        }`}
        aria-hidden={!rightPanelOpen}
      >
        <div
          className={`w-72 h-full transition-opacity duration-200 ${
            rightPanelOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <TaskStatusPanel session={activeSession} />
        </div>
      </div>
    </div>
  )
}

/** Inline question/plan cards rendered above the input box. */
function InlineInteractiveCards({ sessionId }: { sessionId: string }) {
  const requests = useSettingsStore(s => s.permissionRequests)
  const relevant = requests.filter(
    r => r.sessionId === sessionId && (r.type === 'user-question' || r.type === 'plan-approval')
  )
  if (relevant.length === 0) return null

  return (
    <div className="px-4 pb-2 space-y-2">
      {relevant.map(req =>
        req.type === 'user-question'
          ? <InlineQuestionCard key={req.id} request={req} />
          : <InlinePlanCard key={req.id} request={req} />
      )}
    </div>
  )
}

function InlineQuestionCard({ request }: { request: PermissionRequest }) {
  const t = useT()
  const { removePermissionRequest } = useSettingsStore()
  const questions = request.questions || []
  const [answers, setAnswers] = React.useState<Map<number, string>>(new Map())
  const [otherTexts, setOtherTexts] = React.useState<Map<number, string>>(new Map())
  const [currentQ, setCurrentQ] = React.useState(0)

  const handleSelect = (qIdx: number, label: string) => {
    setAnswers(prev => {
      const next = new Map(prev)
      const q = questions[qIdx]
      if (q?.multiSelect) {
        const current = next.get(qIdx) || ''
        const selected = current ? current.split(', ') : []
        if (selected.includes(label)) {
          next.set(qIdx, selected.filter(s => s !== label).join(', '))
        } else {
          next.set(qIdx, [...selected, label].join(', '))
        }
      } else {
        next.set(qIdx, label)
        if (qIdx < questions.length - 1) {
          setTimeout(() => setCurrentQ(qIdx + 1), 150)
        }
      }
      return next
    })
  }

  const isSelected = (qIdx: number, label: string) => {
    const answer = answers.get(qIdx) || ''
    return questions[qIdx]?.multiSelect ? answer.split(', ').includes(label) : answer === label
  }

  const allAnswered = questions.every((_, i) => answers.has(i) && answers.get(i))

  const handleSubmit = () => {
    const answerLines = questions.map((q, i) => `"${q.question}" = "${answers.get(i) || '(no answer)'}"`).join('\n')
    window.electronAPI.sendPermissionResponse({
      requestId: request.id,
      approved: true,
      answerText: `User has answered your questions:\n${answerLines}\n\nContinue with the user's answers in mind.`,
    })
    removePermissionRequest(request.id)
  }

  const handleSkip = () => {
    window.electronAPI.sendPermissionResponse({
      requestId: request.id,
      approved: true,
      answerText: 'User skipped the questions. Proceed with your best judgment.',
    })
    removePermissionRequest(request.id)
  }

  return (
    <div className="bg-white rounded-lg border border-accent/20 shadow-sm overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-accent/5 border-b border-accent/10">
        <span className="text-xs font-medium text-accent">
          {questions.length > 1 ? `${currentQ + 1} / ${questions.length}` : ''}
        </span>
        <span className="text-xs text-text-secondary">{t.question?.title || 'Agent is asking'}</span>
      </div>

      {/* Question */}
      <div className="px-4 py-3">
        {questions.map((q, qIdx) => (
          <div key={qIdx} className={qIdx === currentQ ? '' : 'hidden'}>
            <p className="text-sm font-medium text-charcoal mb-2.5">{q.question}</p>
            <div className="space-y-1.5">
              {q.options.map((opt, oIdx) => (
                <button
                  key={oIdx}
                  onClick={() => handleSelect(qIdx, opt.label)}
                  className={`w-full text-left px-3 py-2 rounded-lg border transition-all ${
                    isSelected(qIdx, opt.label)
                      ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
                      : 'border-border-subtle hover:border-accent/40 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                      isSelected(qIdx, opt.label) ? 'border-accent bg-accent' : 'border-gray-300'
                    }`}>
                      {isSelected(qIdx, opt.label) && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </div>
                    <span className="text-xs font-medium text-charcoal">{opt.label}</span>
                  </div>
                  {opt.description && (
                    <p className="text-[10px] text-text-tertiary mt-0.5 ml-[22px]">{opt.description}</p>
                  )}
                </button>
              ))}
              {/* Other option */}
              <div className={`w-full text-left px-3 py-2 rounded-lg border transition-all ${
                answers.get(qIdx) && !q.options.some(o => o.label === answers.get(qIdx))
                  ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
                  : 'border-dashed border-border-subtle'
              }`}>
                <div className="flex items-center gap-2">
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 shrink-0" />
                  <input
                    type="text"
                    placeholder={t.question?.otherPlaceholder || 'Other...'}
                    value={otherTexts.get(qIdx) || ''}
                    onChange={e => setOtherTexts(prev => new Map(prev).set(qIdx, e.target.value))}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const text = otherTexts.get(qIdx)?.trim()
                        if (text) {
                          setAnswers(prev => new Map(prev).set(qIdx, text))
                          if (qIdx < questions.length - 1) setTimeout(() => setCurrentQ(qIdx + 1), 150)
                        }
                      }
                    }}
                    className="flex-1 text-xs bg-transparent outline-none placeholder:text-text-tertiary"
                  />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-border-subtle bg-gray-50/50">
        <div className="flex gap-2">
          {questions.length > 1 && currentQ > 0 && (
            <button onClick={() => setCurrentQ(currentQ - 1)} className="text-[10px] text-text-tertiary hover:text-charcoal">
              {t.question?.prev || '< Prev'}
            </button>
          )}
          {questions.length > 1 && currentQ < questions.length - 1 && (
            <button onClick={() => setCurrentQ(currentQ + 1)} className="text-[10px] text-accent hover:text-accent-dark">
              {t.question?.next || 'Next >'}
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={handleSkip} className="text-[10px] text-text-tertiary hover:text-charcoal">
            {t.question?.skip || 'Skip'}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!allAnswered}
            className="px-3 py-1 rounded-full text-[10px] font-medium bg-accent text-white disabled:opacity-40"
          >
            {t.question?.submit || 'Submit'}
          </button>
        </div>
      </div>
    </div>
  )
}

function InlinePlanCard({ request }: { request: PermissionRequest }) {
  const t = useT()
  const { removePermissionRequest } = useSettingsStore()
  const planContent = request.planContent || request.description || ''
  const keyActions = request.planFiles || []
  const [showFeedback, setShowFeedback] = React.useState(false)
  const [feedback, setFeedback] = React.useState('')

  const handleApprove = () => {
    window.electronAPI.sendPermissionResponse({ requestId: request.id, approved: true })
    removePermissionRequest(request.id)
  }

  const handleReject = () => {
    if (!showFeedback) { setShowFeedback(true); return }
    window.electronAPI.sendPermissionResponse({
      requestId: request.id,
      approved: false,
      answerText: feedback.trim() || undefined,
    })
    removePermissionRequest(request.id)
  }

  return (
    <div className="bg-white rounded-lg border border-green-200 shadow-sm overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-green-50 border-b border-green-100">
        <span className="text-xs font-medium text-green-700">{t.plan?.approvalTitle || 'Plan Ready'}</span>
      </div>

      {/* Summary + key actions */}
      <div className="px-4 py-3">
        <p className="text-sm text-charcoal mb-2">{request.description}</p>
        {keyActions.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {keyActions.map((a, i) => (
              <span key={i} className="text-[10px] px-2 py-0.5 bg-gray-100 rounded font-mono text-text-secondary">{a}</span>
            ))}
          </div>
        )}
        {/* Collapsible full plan */}
        <details className="text-xs">
          <summary className="text-text-tertiary cursor-pointer hover:text-charcoal">{t.plan?.showDetails || 'Show full plan'}</summary>
          <div className="mt-2 p-2 bg-gray-50 rounded text-text-secondary max-h-40 overflow-y-auto whitespace-pre-wrap">{planContent}</div>
        </details>
        {showFeedback && (
          <textarea
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            placeholder={t.plan?.feedbackPlaceholder || 'What should be changed?'}
            className="mt-2 w-full text-xs border border-border-subtle rounded p-2 h-16 resize-none outline-none focus:border-accent/40"
            autoFocus
          />
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 px-4 py-2 border-t border-border-subtle bg-gray-50/50">
        <button
          onClick={handleReject}
          className="px-3 py-1 rounded-full text-[10px] text-text-secondary border border-border-subtle hover:border-danger/30 hover:text-danger"
        >
          {showFeedback ? (t.plan?.submitFeedback || 'Send Feedback') : (t.plan?.reject || 'Reject')}
        </button>
        <button onClick={handleApprove} className="px-3 py-1 rounded-full text-[10px] font-medium bg-green-600 text-white hover:bg-green-700">
          {t.plan?.approve || 'Approve'}
        </button>
      </div>
    </div>
  )
}
