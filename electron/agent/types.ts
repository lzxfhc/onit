export interface AgentToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, any>
      required: string[]
    }
  }
  /** Whether this tool can safely run concurrently with other concurrency-safe tools. */
  concurrencySafe?: boolean
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
  tool_call_id?: string
  name?: string
}

export type RiskLevel = 'safe' | 'moderate' | 'dangerous'

export interface ToolExecutionResult {
  success: boolean
  output: string
  riskLevel: RiskLevel
}
