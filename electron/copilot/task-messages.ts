import type { Message, StreamChunk, ToolCall } from '../../src/types'

function upsertToolCall(toolCalls: ToolCall[] | undefined, nextToolCall: ToolCall): ToolCall[] {
  const nextCalls = toolCalls ? [...toolCalls] : []
  const existingIndex = nextCalls.findIndex(toolCall => toolCall.id === nextToolCall.id)

  if (existingIndex >= 0) {
    nextCalls[existingIndex] = { ...nextCalls[existingIndex], ...nextToolCall }
  } else {
    nextCalls.push(nextToolCall)
  }

  return nextCalls
}

function applyChunkToAssistantMessage(message: Message, chunk: StreamChunk): Message {
  if (chunk.type === 'content' && chunk.content) {
    const blocks = message.contentBlocks ? [...message.contentBlocks] : []
    if (blocks.length > 0 && blocks[blocks.length - 1].type === 'text') {
      const previous = blocks[blocks.length - 1]
      blocks[blocks.length - 1] = {
        ...previous,
        content: (previous.content || '') + chunk.content,
      }
    } else {
      blocks.push({ type: 'text', content: chunk.content })
    }

    return {
      ...message,
      content: message.content + chunk.content,
      contentBlocks: blocks,
    }
  }

  if (chunk.type === 'thinking' && chunk.content) {
    return {
      ...message,
      thinking: (message.thinking || '') + chunk.content,
    }
  }

  if (chunk.type === 'tool-call-start' && chunk.toolCall) {
    const blocks = message.contentBlocks ? [...message.contentBlocks] : []
    blocks.push({ type: 'tool-call', toolCallId: chunk.toolCall.id })

    return {
      ...message,
      toolCalls: upsertToolCall(message.toolCalls, chunk.toolCall),
      contentBlocks: blocks,
    }
  }

  if (chunk.type === 'tool-call-result' && chunk.toolCall) {
    return {
      ...message,
      toolCalls: upsertToolCall(message.toolCalls, chunk.toolCall),
    }
  }

  if (chunk.type === 'iteration-end') {
    const blocks = message.contentBlocks ? [...message.contentBlocks] : []
    blocks.push({ type: 'iteration-end', iterationIndex: chunk.iterationIndex })

    return {
      ...message,
      contentBlocks: blocks,
      iterationIndex: chunk.iterationIndex,
    }
  }

  if (chunk.type === 'reconnect') {
    const blocks = message.contentBlocks ? [...message.contentBlocks] : []
    if (blocks.length === 0) {
      return { ...message, content: '', contentBlocks: [] }
    }

    let boundaryIndex = -1
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === 'iteration-end') {
        boundaryIndex = i
        break
      }
    }

    const keptBlocks = boundaryIndex >= 0 ? blocks.slice(0, boundaryIndex + 1) : []
    const nextContent = keptBlocks
      .filter(block => block.type === 'text')
      .map(block => block.content || '')
      .join('')

    const keptToolCallIds = new Set(
      keptBlocks
        .filter(block => block.type === 'tool-call')
        .map(block => block.toolCallId)
        .filter(Boolean) as string[],
    )

    const nextToolCalls = message.toolCalls && message.toolCalls.length > 0
      ? message.toolCalls.filter(toolCall => keptToolCallIds.has(toolCall.id))
      : message.toolCalls

    return {
      ...message,
      content: nextContent,
      contentBlocks: keptBlocks,
      toolCalls: nextToolCalls,
    }
  }

  return message
}

export function buildTaskRunMessages(
  history: Message[],
  userContent: string,
  runId: string,
  timestamp: number,
): Message[] {
  const userMessage: Message = {
    id: `${runId}-user`,
    role: 'user',
    content: userContent,
    timestamp,
  }

  const assistantMessage: Message = {
    id: `${runId}-assistant`,
    role: 'assistant',
    content: '',
    timestamp,
    isStreaming: true,
    toolCalls: [],
    contentBlocks: [],
    runId,
  }

  return [...history, userMessage, assistantMessage]
}

export function applyTaskStreamChunks(messages: Message[], runId: string, chunks: StreamChunk[]): Message[] {
  if (chunks.length === 0) return messages

  const nextMessages = [...messages]
  const assistantIndex = nextMessages.findIndex(
    message => message.role === 'assistant' && message.runId === runId && message.isStreaming,
  )

  if (assistantIndex < 0) return messages

  let nextAssistant = nextMessages[assistantIndex]
  for (const chunk of chunks) {
    nextAssistant = applyChunkToAssistantMessage(nextAssistant, chunk)
  }
  nextMessages[assistantIndex] = nextAssistant

  return nextMessages
}

export function completeTaskRun(messages: Message[], runId: string): Message[] {
  return messages.map(message => (
    message.role === 'assistant' && message.isStreaming && (!runId || message.runId === runId)
      ? { ...message, isStreaming: false }
      : message
  ))
}

export function applyTaskError(messages: Message[], runId: string, error: string, timestamp: number): Message[] {
  const nextMessages = [...messages]
  const lastIndex = nextMessages.length - 1
  const lastMessage = nextMessages[lastIndex]

  if (lastMessage?.role === 'assistant' && lastMessage.runId === runId) {
    if (!lastMessage.content.trim()) {
      nextMessages[lastIndex] = {
        ...lastMessage,
        content: `Error: ${error}`,
        isStreaming: false,
      }
      return nextMessages
    }

    nextMessages[lastIndex] = { ...lastMessage, isStreaming: false }
  }

  nextMessages.push({
    id: `${runId}-error-${timestamp}`,
    role: 'assistant',
    content: `Error: ${error}`,
    timestamp,
    runId,
  })

  return nextMessages
}

export function extractTaskResult(messages: Message[]): { finalResponse?: string; summary?: string } {
  const latestAssistant = [...messages]
    .reverse()
    .find(message => message.role === 'assistant' && message.content.trim())

  if (!latestAssistant) return {}

  const finalResponse = latestAssistant.content.trim()
  const firstParagraph = finalResponse.split(/\n\s*\n/).find(Boolean)?.trim() || finalResponse
  const summaryBase = firstParagraph.length > 280
    ? `${firstParagraph.slice(0, 280).trim()}...`
    : firstParagraph

  return {
    finalResponse,
    summary: summaryBase,
  }
}
