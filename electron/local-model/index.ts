import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
import * as http from 'http'
import { v4 as uuidv4 } from 'uuid'
import { buildChatHistory, buildFunctions, parseToolCallsFromText } from './hermes'

class AsyncMutex {
  private locked = false
  private waiters: Array<() => void> = []

  private async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.locked = true
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      // Keep locked=true; ownership transfers to the next waiter.
      next()
      return
    }
    this.locked = false
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

// Types shared with renderer
interface LocalModelDef {
  id: string
  name: string
  displayName: string
  description: string
  fileName: string
  downloadUrl: string
  fileSize: number
  contextSize: number
  maxInputTokens: number
  maxOutputTokens: number
}

type LocalModelStatus =
  | 'not-downloaded'
  | 'downloading'
  | 'downloaded'
  | 'loading'
  | 'ready'
  | 'error'

interface LocalModelState {
  modelId: string
  status: LocalModelStatus
  downloadProgress?: number
  error?: string
}

interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: any[]
  tool_call_id?: string
  name?: string
}

const AVAILABLE_LOCAL_MODELS: LocalModelDef[] = [
  {
    id: 'qwen3.5-4b',
    name: 'Qwen3.5-4B',
    displayName: 'Qwen3.5 4B',
    description: '通义千问3.5 4B 模型，工具调用能力强，适合 8GB+ 内存设备',
    fileName: 'Qwen3.5-4B-Q4_K_M.gguf',
    downloadUrl: 'https://modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/master/Qwen3.5-4B-Q4_K_M.gguf',
    fileSize: 2_860_000_000,
    contextSize: 262144,
    maxInputTokens: 24000,
    maxOutputTokens: 8000,
  },
  {
    id: 'qwen3.5-0.8b',
    name: 'Qwen3.5-0.8B',
    displayName: 'Qwen3.5 0.8B',
    description: '通义千问3.5 0.8B 轻量模型，体积小速度快，适合轻量任务',
    fileName: 'Qwen3.5-0.8B-Q8_0.gguf',
    downloadUrl: 'https://modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF/resolve/master/Qwen3.5-0.8B-Q8_0.gguf',
    fileSize: 812_000_000,
    contextSize: 262144,
    maxInputTokens: 24000,
    maxOutputTokens: 8000,
  },
]

function getModelDef(modelId: string): LocalModelDef | undefined {
  return AVAILABLE_LOCAL_MODELS.find(m => m.id === modelId)
}

export class LocalModelManager {
  private readonly opMutex = new AsyncMutex()
  private llama: any = null
  private model: any = null
  private context: any = null
  private llamaChat: any = null
  private currentModelId: string | null = null
  private status: LocalModelStatus = 'not-downloaded'
  private downloadAbortController: AbortController | null = null

  constructor(private modelsDir: string) {
    fs.mkdirSync(modelsDir, { recursive: true })
    this.cleanupObsoleteFiles()
  }

  /**
   * Remove model files that are no longer in AVAILABLE_LOCAL_MODELS.
   * Runs once on startup to free disk space after model upgrades.
   */
  private cleanupObsoleteFiles(): void {
    try {
      const knownFiles = new Set<string>()
      for (const m of AVAILABLE_LOCAL_MODELS) {
        knownFiles.add(m.fileName)
        knownFiles.add(m.fileName + '.downloading')
      }

      const files = fs.readdirSync(this.modelsDir)
      for (const file of files) {
        if (!knownFiles.has(file) && (file.endsWith('.gguf') || file.endsWith('.downloading'))) {
          fs.unlinkSync(path.join(this.modelsDir, file))
          console.log(`[LocalModel] Cleaned up obsolete file: ${file}`)
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  getModelPath(modelDef: LocalModelDef): string {
    return path.join(this.modelsDir, modelDef.fileName)
  }

  private getTempPath(modelDef: LocalModelDef): string {
    return path.join(this.modelsDir, modelDef.fileName + '.downloading')
  }

  async checkModelStatus(modelId?: string): Promise<LocalModelState> {
    const id = modelId || AVAILABLE_LOCAL_MODELS[0]?.id
    if (!id) return { modelId: '', status: 'error', error: 'No models available' }

    const modelDef = getModelDef(id)
    if (!modelDef) return { modelId: id, status: 'error', error: 'Unknown model' }

    if (this.currentModelId === id && this.llamaChat) {
      return { modelId: id, status: 'ready' }
    }

    if (this.currentModelId === id && this.status === 'loading') {
      return { modelId: id, status: 'loading' }
    }

    if (this.status === 'downloading' && this.downloadAbortController) {
      return { modelId: id, status: 'downloading' }
    }

    const filePath = this.getModelPath(modelDef)
    if (fs.existsSync(filePath)) {
      return { modelId: id, status: 'downloaded' }
    }

    const tempPath = this.getTempPath(modelDef)
    if (fs.existsSync(tempPath)) {
      return { modelId: id, status: 'not-downloaded' }
    }

    return { modelId: id, status: 'not-downloaded' }
  }

  async downloadModel(
    modelId: string,
    onProgress: (progress: number, speed?: number) => void
  ): Promise<void> {
    if (this.status === 'downloading') throw new Error('Download already in progress')

    const modelDef = getModelDef(modelId)
    if (!modelDef) throw new Error(`Unknown model: ${modelId}`)

    const filePath = this.getModelPath(modelDef)
    if (fs.existsSync(filePath)) return

    const tempPath = this.getTempPath(modelDef)
    this.status = 'downloading'
    this.downloadAbortController = new AbortController()

    const existingSize = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0

    return new Promise<void>((resolve, reject) => {
      const abortHandler = () => {
        reject(new Error('Download cancelled'))
      }
      this.downloadAbortController!.signal.addEventListener('abort', abortHandler, { once: true })

      const doRequest = (url: string, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error('Too many redirects'))
          return
        }

        const parsedUrl = new URL(url)
        const httpModule = parsedUrl.protocol === 'https:' ? https : http
        const headers: Record<string, string> = {
          'User-Agent': 'Onit/1.3.0',
        }
        if (existingSize > 0) {
          headers['Range'] = `bytes=${existingSize}-`
        }

        const req = httpModule.get(url, { headers }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            doRequest(res.headers.location, redirectCount + 1)
            return
          }

          if (res.statusCode && res.statusCode >= 400) {
            this.status = 'error'
            reject(new Error(`Download failed: HTTP ${res.statusCode}`))
            return
          }

          const totalSize = modelDef.fileSize
          let downloadedSize = existingSize
          let writeFlags: 'a' | 'w' = existingSize > 0 ? 'a' : 'w'

          // H8: Verify resume is actually working
          if (existingSize > 0 && res.statusCode === 200) {
            // Server ignored Range header, restart from beginning
            downloadedSize = 0
            writeFlags = 'w'
          }
          // statusCode 206 means partial content — resume is working, append as expected

          let lastSpeedTime = Date.now()
          let lastSpeedBytes = downloadedSize
          let currentSpeed = 0
          const writeStream = fs.createWriteStream(tempPath, { flags: writeFlags })

          res.on('data', (chunk: Buffer) => {
            if (this.downloadAbortController?.signal.aborted) {
              req.destroy()
              writeStream.close()
              return
            }
            writeStream.write(chunk)
            downloadedSize += chunk.length

            // Calculate speed every 500ms to avoid excessive updates
            const now = Date.now()
            const elapsed = now - lastSpeedTime
            if (elapsed >= 500) {
              currentSpeed = ((downloadedSize - lastSpeedBytes) / elapsed) * 1000
              lastSpeedTime = now
              lastSpeedBytes = downloadedSize
            }

            const progress = Math.min(99, Math.round((downloadedSize / totalSize) * 100))
            onProgress(progress, currentSpeed)
          })

          res.on('end', () => {
            writeStream.close(() => {
              if (this.downloadAbortController?.signal.aborted) return

              // M18: Validate file size before finalizing
              const actualSize = fs.statSync(tempPath).size
              if (actualSize < modelDef.fileSize * 0.95) {
                fs.unlinkSync(tempPath)
                this.status = 'error'
                reject(new Error('Download incomplete'))
                return
              }

              fs.renameSync(tempPath, filePath)
              this.status = 'downloaded'
              onProgress(100)
              resolve()
            })
          })

          res.on('error', (err) => {
            writeStream.close()
            this.status = 'error'
            reject(err)
          })
        })

        req.on('error', (err) => {
          this.status = 'error'
          reject(err)
        })

        this.downloadAbortController!.signal.addEventListener('abort', () => {
          req.destroy()
        }, { once: true })
      }

      doRequest(modelDef.downloadUrl)
    })
  }

  cancelDownload(): void {
    if (this.downloadAbortController) {
      this.downloadAbortController.abort()
      this.downloadAbortController = null
      this.status = 'not-downloaded'
    }
  }

  async deleteModel(modelId: string): Promise<void> {
    await this.opMutex.runExclusive(async () => {
      const modelDef = getModelDef(modelId)
      if (!modelDef) return

      if (this.currentModelId === modelId) {
        await this.unloadModelUnlocked()
      }

      const filePath = this.getModelPath(modelDef)
      const tempPath = this.getTempPath(modelDef)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
      this.status = 'not-downloaded'
    })
  }

  async loadModel(modelId: string): Promise<void> {
    await this.opMutex.runExclusive(async () => {
      const modelDef = getModelDef(modelId)
      if (!modelDef) throw new Error(`Unknown model: ${modelId}`)

      const filePath = this.getModelPath(modelDef)
      if (!fs.existsSync(filePath)) throw new Error('Model file not found. Please download first.')

      if (this.currentModelId === modelId && this.llamaChat) return

      await this.unloadModelUnlocked()
      this.status = 'loading'
      this.currentModelId = modelId

      try {
        const { getLlama } = await import('node-llama-cpp')
        this.llama = await getLlama()
        this.model = await this.llama.loadModel({ modelPath: filePath })
        this.context = await this.model.createContext({
          contextSize: Math.min(modelDef.contextSize, 32768),
        })

        const { LlamaChat } = await import('node-llama-cpp')
        this.llamaChat = new LlamaChat({
          contextSequence: this.context.getSequence(),
        })

        this.status = 'ready'
      } catch (err: any) {
        this.status = 'error'
        this.currentModelId = null
        throw new Error(`Failed to load model: ${err.message}`)
      }
    })
  }

  async unloadModel(): Promise<void> {
    await this.opMutex.runExclusive(async () => {
      await this.unloadModelUnlocked()
    })
  }

  private async unloadModelUnlocked(): Promise<void> {
    this.llamaChat = null
    if (this.context) {
      await this.context.dispose?.()
      this.context = null
    }
    if (this.model) {
      await this.model.dispose?.()
      this.model = null
    }
    this.llama = null
    this.currentModelId = null
    // M20: Don't set status here — let checkModelStatus derive it from filesystem state.
    // Setting 'not-downloaded' was wrong when the model file still exists on disk.
  }

  isReady(): boolean {
    return this.status === 'ready' && this.llamaChat !== null
  }

  async generateCompletion(params: {
    messages: AgentMessage[]
    tools?: any[]
    temperature?: number
    maxTokens?: number
    abortSignal?: AbortSignal
    onToken?: (chunk: { type: 'content' | 'thinking'; content: string }) => void
    expectedModelId?: string
  }): Promise<{ content: string; toolCalls: any[] }> {
    const expectedModelId = params.expectedModelId
    return this.opMutex.runExclusive(async () => {
      if (expectedModelId && this.currentModelId !== expectedModelId) {
        throw new Error('Model was changed by another session')
      }
      if (!this.llamaChat || !this.model) {
        throw new Error('Model not loaded')
      }

      const chatHistory = buildChatHistory(params.messages, params.tools)
      const functions = params.tools ? buildFunctions(params.tools) : undefined

      let fullContent = ''

      try {
        const response = await this.llamaChat.generateResponse(chatHistory, {
          functions,
          temperature: params.temperature ?? 0.7,
          maxTokens: params.maxTokens ?? 8000,
          signal: params.abortSignal,
          onTextChunk: (text: string) => {
            fullContent += text
            params.onToken?.({ type: 'content', content: text })
          },
        })

        // Extract function calls from the response
        // node-llama-cpp v3 returns { response: string, functionCalls?: [...], metadata, lastEvaluation }
        const toolCalls: any[] = []

        if (response?.functionCalls && Array.isArray(response.functionCalls)) {
          for (const fc of response.functionCalls) {
            toolCalls.push({
              id: `call_${uuidv4().slice(0, 8)}`,
              type: 'function',
              function: {
                name: fc.functionName,
                arguments: JSON.stringify(fc.params),
              },
            })
          }
        }

        // Fallback: parse <tool_call> tags from text output (when grammar enforcement is inactive)
        if (toolCalls.length === 0 && fullContent.includes('<tool_call>')) {
          const parsed = parseToolCallsFromText(fullContent)
          fullContent = parsed.content
          toolCalls.push(...parsed.toolCalls)
        }

        return { content: fullContent, toolCalls }
      } catch (err: any) {
        if (err.name === 'AbortError' || params.abortSignal?.aborted) {
          throw new Error('Agent stopped')
        }
        throw err
      }
    })
  }
}
