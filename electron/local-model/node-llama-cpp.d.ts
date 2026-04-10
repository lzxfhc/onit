// Type declarations for node-llama-cpp (resolved at runtime via dynamic import)
declare module 'node-llama-cpp' {
  export function getLlama(options?: { gpu?: boolean | string; build?: string; debug?: boolean }): Promise<Llama>

  export interface Llama {
    loadModel(options: { modelPath: string; gpuLayers?: number }): Promise<LlamaModel>
  }

  export interface LlamaModel {
    createContext(options?: { contextSize?: number }): Promise<LlamaContext>
    dispose(): Promise<void>
  }

  export interface LlamaContext {
    getSequence(): LlamaContextSequence
    dispose(): Promise<void>
  }

  export interface LlamaContextSequence {}

  export interface LlamaChatResponseFunctionCall {
    functionName: string
    params: any
    raw: any
  }

  export interface LlamaChatResponse {
    response: string
    fullResponse: Array<string | any>
    functionCalls?: LlamaChatResponseFunctionCall[]
    lastEvaluation: {
      cleanHistory: ChatHistoryItem[]
      contextWindow: ChatHistoryItem[]
      contextShiftMetadata: any
    }
    metadata: {
      remainingGenerationAfterStop?: string | any[]
      stopReason: 'eogToken' | 'stopGenerationTrigger' | 'functionCalls' | 'maxTokens' | 'abort' | 'customStopTrigger'
    }
  }

  export class LlamaChat {
    constructor(options: { contextSequence: LlamaContextSequence })
    generateResponse(
      chatHistory: ChatHistoryItem[],
      options?: {
        functions?: Record<string, ChatModelFunction>
        temperature?: number
        maxTokens?: number
        signal?: AbortSignal
        onTextChunk?: (text: string) => void
        onToken?: (tokens: any[]) => void
        lastEvaluationContextWindow?: any
      }
    ): Promise<LlamaChatResponse>
  }

  export class LlamaChatSession {
    constructor(options: { contextSequence: LlamaContextSequence })
    prompt(
      text: string,
      options?: {
        functions?: Record<string, any>
        temperature?: number
        maxTokens?: number
        signal?: AbortSignal
        onTextChunk?: (text: string) => void
        onToken?: (tokens: any[]) => void
      }
    ): Promise<string>
  }

  export type ChatHistoryItem =
    | { type: 'system'; text: string }
    | { type: 'user'; text: string }
    | { type: 'model'; response: any[] }

  export interface ChatModelFunction {
    description: string
    params?: Record<string, any>
  }
}
