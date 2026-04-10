import { v4 as uuidv4 } from 'uuid'

interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: any[]
  tool_call_id?: string
  name?: string
}

/**
 * Convert OpenAI-format tool definitions to node-llama-cpp ChatModelFunctions format.
 *
 * OpenAI: { type: 'function', function: { name, description, parameters } }
 * node-llama-cpp: { [name]: { description, params } }
 */
export function buildFunctions(tools: any[]): Record<string, any> {
  const functions: Record<string, any> = {}

  for (const tool of tools) {
    if (tool.type === 'function' && tool.function) {
      functions[tool.function.name] = {
        description: tool.function.description || '',
        params: tool.function.parameters || { type: 'object', properties: {} },
      }
    }
  }

  return functions
}

/**
 * Convert OpenAI-format messages to node-llama-cpp ChatHistoryItem[].
 *
 * Handles the mapping:
 *   system      → { type: 'system', text }
 *   user        → { type: 'user', text }
 *   assistant   → { type: 'model', response: [...] }
 *   tool result → folded into previous model's functionCall as .result
 */
export function buildChatHistory(messages: AgentMessage[], tools?: any[]): any[] {
  const history: any[] = []

  // Collect tool results indexed by tool_call_id for folding into model responses.
  // M22: Also index by fallback IDs so results are not dropped when tool_call_id is undefined.
  const toolResults = new Map<string, string>()
  let toolResultFallbackIdx = 0
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // Reset fallback counter for each assistant message's tool_calls group
      toolResultFallbackIdx = 0
    } else if (msg.role === 'tool') {
      const resultId = msg.tool_call_id || `fallback_${toolResultFallbackIdx}`
      toolResults.set(resultId, msg.content)
      toolResultFallbackIdx++
    }
  }

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        history.push({ type: 'system', text: msg.content })
        break

      case 'user':
        history.push({ type: 'user', text: msg.content })
        break

      case 'assistant': {
        const response: any[] = []

        if (msg.content) {
          response.push(msg.content)
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (let tcIndex = 0; tcIndex < msg.tool_calls.length; tcIndex++) {
            const tc = msg.tool_calls[tcIndex]
            const callId = tc.id || `fallback_${tcIndex}`
            let params: any = {}
            try {
              params = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments
            } catch {
              // Keep empty params if parse fails
            }

            const funcCall: any = {
              type: 'functionCall',
              name: tc.function.name,
              params,
            }

            // Attach the tool result if available
            const result = toolResults.get(callId)
            if (result !== undefined) {
              funcCall.result = result
            }

            response.push(funcCall)
          }
        }

        if (response.length === 0) {
          response.push('')
        }

        history.push({ type: 'model', response })
        break
      }

      case 'tool':
        // Tool results are folded into the assistant's functionCall above.
        // Skip standalone tool messages.
        break
    }
  }

  return history
}

/**
 * Fallback: Parse Hermes-format <tool_call> tags from raw model text output.
 * Used when grammar enforcement doesn't catch tool calls.
 */
export function parseToolCallsFromText(text: string): {
  content: string
  toolCalls: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
} {
  const toolCalls: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }> = []

  // Match <tool_call>...</tool_call> blocks
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let match: RegExpExecArray | null
  let cleanContent = text

  while ((match = toolCallRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      const name = parsed.name || parsed.function?.name || ''
      const args = parsed.arguments || parsed.parameters || parsed.params || {}

      toolCalls.push({
        id: `call_${uuidv4().slice(0, 8)}`,
        type: 'function',
        function: {
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        },
      })
    } catch {
      // Skip unparseable tool calls
    }
  }

  // Remove tool_call blocks from content
  cleanContent = text.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/g, '').trim()

  return { content: cleanContent, toolCalls }
}
