import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { URL } from 'url'
import { v4 as uuidv4 } from 'uuid'
import { executeTool, AGENT_TOOLS, getToolRiskLevel } from './tools'
import { AgentMessage } from './types'

interface SkillData {
  name: string
  displayName: string
  description: string
  content: string
}

interface SessionToolCallData {
  id?: string
  name?: string
  arguments?: string
  status?: 'pending' | 'running' | 'completed' | 'error' | string
  result?: string
  error?: string
}

interface SessionContentBlockData {
  type?: 'text' | 'tool-call' | 'iteration-end' | string
  content?: string
  toolCallId?: string
  iterationIndex?: number
}

interface SessionMessageData {
  role?: 'system' | 'user' | 'assistant' | 'tool' | string
  content?: string
  toolCalls?: SessionToolCallData[]
  contentBlocks?: SessionContentBlockData[]
}

type RestoredToolCall = NonNullable<AgentMessage['tool_calls']>[number]

const MAX_ATTACHED_FILES = 8
const MAX_ATTACHED_FILE_CHARS = 12000
const MAX_TOTAL_ATTACHED_CHARS = 40000
const MAX_RESTORED_TOOL_CONTENT_CHARS = 3000

interface AgentSession {
  sessionId: string
  runId: string
  messages: AgentMessage[]
  abortController: AbortController | null
  isRunning: boolean
  completionStatus: 'completed' | 'stopped' | 'error'
  permissionMode: string
  workspacePath: string | null
  model: string
  apiConfig: {
    billingMode: string
    apiKey: string
    customBaseUrl?: string
    codingPlanProvider?: string
  }
  alwaysAllowedTools: Set<string>
  pendingPermissions: Map<string, { resolve: (approved: boolean) => void }>
  enabledSkills?: SkillData[]
}

export class AgentManager {
  private sessions: Map<string, AgentSession> = new Map()
  private sendToRenderer: (channel: string, data: any) => void

  constructor(sendToRenderer: (channel: string, data: any) => void) {
    this.sendToRenderer = sendToRenderer
  }

  async startAgent(sessionId: string, userMessage: string, runId: string, sessionData: any): Promise<boolean> {
    let agentSession = this.sessions.get(sessionId)

    if (agentSession?.isRunning) {
      this.stopAgent(sessionId)
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    const apiConfig = sessionData.apiConfig || {}
    const enabledSkills: SkillData[] = sessionData.enabledSkills || []
    const attachedFileMessages = this.buildAttachedFileMessages(sessionData.attachedFiles || [])

    // Parse @skill-name mentions from user message and inject skill content
    const mentionedSkillContents = this.extractMentionedSkills(userMessage, enabledSkills)

    // Build the system prompt
    const systemPrompt = this.buildSystemPrompt(
      sessionData.workspacePath,
      sessionData.permissionMode,
      enabledSkills,
    )

    // Restore conversation history from session
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt }
    ]

    // Inject mentioned skill contents as system messages
    for (const skillContent of mentionedSkillContents) {
      messages.push({ role: 'system', content: skillContent })
    }

    for (const attachedFileMessage of attachedFileMessages) {
      messages.push(attachedFileMessage)
    }

    // Add existing messages from session (convert from renderer format)
    if (sessionData.messages) {
      messages.push(...this.restoreConversationHistory(sessionData.messages as SessionMessageData[]))
    }

    // Add the new user message
    messages.push({ role: 'user', content: userMessage })

    agentSession = {
      sessionId,
      runId,
      messages,
      abortController: new AbortController(),
      isRunning: true,
      completionStatus: 'completed',
      permissionMode: sessionData.permissionMode || 'accept-edit',
      workspacePath: sessionData.workspacePath,
      model: sessionData.model || 'qianfan-code-latest',
      apiConfig: {
        billingMode: apiConfig.billingMode || 'coding-plan',
        apiKey: apiConfig.apiKey || '',
        customBaseUrl: apiConfig.customBaseUrl,
        codingPlanProvider: apiConfig.codingPlanProvider,
      },
      alwaysAllowedTools: agentSession?.alwaysAllowedTools || new Set(),
      pendingPermissions: new Map(),
      enabledSkills,
    }

    this.sessions.set(sessionId, agentSession)

    // Run the agent loop asynchronously
    this.runAgentLoop(agentSession).catch(error => {
      this.sendToRenderer('agent:error', {
        sessionId,
        runId,
        error: error.message || 'Unknown agent error',
      })
    })

    return true
  }

  stopAgent(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.isRunning = false
      session.completionStatus = 'stopped'
      session.abortController?.abort()
      session.abortController = null
      for (const [, pending] of session.pendingPermissions) {
        pending.resolve(false)
      }
      session.pendingPermissions.clear()
    }
    return true
  }

  stopAll(): void {
    for (const [sessionId] of this.sessions) {
      this.stopAgent(sessionId)
    }
  }

  handlePermissionResponse(requestId: string, approved: boolean, alwaysAllow?: boolean): void {
    for (const [, session] of this.sessions) {
      const pending = session.pendingPermissions.get(requestId)
      if (pending) {
        if (alwaysAllow && approved) {
          const parts = requestId.split(':')
          if (parts.length > 1) {
            session.alwaysAllowedTools.add(parts[1])
          }
        }
        pending.resolve(approved)
        session.pendingPermissions.delete(requestId)
        return
      }
    }
  }

  private extractMentionedSkills(message: string, enabledSkills: SkillData[]): string[] {
    const contents: string[] = []
    const mentionPattern = /@([\w-]+)/g
    let match: RegExpExecArray | null

    while ((match = mentionPattern.exec(message)) !== null) {
      const skillName = match[1]
      const skill = enabledSkills.find(s => s.name === skillName)
      if (skill && skill.content) {
        // Inject full skill content, capped at 5000 chars
        const injected = skill.content.length > 5000
          ? skill.content.substring(0, 5000) + '\n\n[Skill content truncated]'
          : skill.content
        contents.push(`[Skill: ${skill.displayName}]\n\n${injected}`)
      }
    }

    return contents
  }

  private buildAttachedFileMessages(attachedFiles: string[]): AgentMessage[] {
    const messages: AgentMessage[] = []
    let totalChars = 0

    for (const filePath of attachedFiles.slice(0, MAX_ATTACHED_FILES)) {
      try {
        if (!fs.existsSync(filePath)) {
          messages.push({
            role: 'system',
            content: `[Attached File Unavailable]\n\nThe user attached this file, but it could not be found: ${filePath}`,
          })
          continue
        }

        const stat = fs.statSync(filePath)
        if (!stat.isFile()) continue

        const remainingChars = MAX_TOTAL_ATTACHED_CHARS - totalChars
        if (remainingChars <= 0) break

        const content = fs.readFileSync(filePath, 'utf-8')
        const cap = Math.min(MAX_ATTACHED_FILE_CHARS, remainingChars)
        const truncated = content.length > cap
        const excerpt = truncated ? `${content.slice(0, cap)}\n\n[Attached file truncated]` : content

        totalChars += excerpt.length
        messages.push({
          role: 'system',
          content: `[Attached File: ${filePath}]\n\n${excerpt}`,
        })
      } catch {
        messages.push({
          role: 'system',
          content: `[Attached File Unreadable]\n\nThe user attached this file, but it could not be decoded as text: ${filePath}`,
        })
      }
    }

    return messages
  }

  private restoreConversationHistory(sessionMessages: SessionMessageData[]): AgentMessage[] {
    const restored: AgentMessage[] = []

    for (const message of sessionMessages) {
      if (!message) continue

      if (message.role === 'user') {
        restored.push({ role: 'user', content: typeof message.content === 'string' ? message.content : '' })
        continue
      }

      if (message.role === 'assistant') {
        restored.push(...this.restoreAssistantMessage(message))
      }
    }

    return restored
  }

  private restoreAssistantMessage(message: SessionMessageData): AgentMessage[] {
    const contentBlocks = Array.isArray(message.contentBlocks) ? message.contentBlocks : []

    if (contentBlocks.length > 0) {
      const restoredFromBlocks = this.restoreAssistantMessageFromBlocks(message)
      if (restoredFromBlocks.length > 0) {
        return restoredFromBlocks
      }
    }

    return this.restoreAssistantMessageFallback(message)
  }

  private restoreAssistantMessageFromBlocks(message: SessionMessageData): AgentMessage[] {
    const restored: AgentMessage[] = []
    const contentBlocks = Array.isArray(message.contentBlocks) ? message.contentBlocks : []
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : []
    const toolCallMap = new Map<string, SessionToolCallData>()
    const consumedToolCallIds = new Set<string>()

    for (const toolCall of toolCalls) {
      if (toolCall.id) {
        toolCallMap.set(toolCall.id, toolCall)
      }
    }

    let currentText = ''
    let currentToolCallIds: string[] = []

    const flushCurrentTurn = () => {
      const assistantContent = this.normalizeRestoredAssistantContent(currentText)
      const restoredToolCalls = currentToolCallIds
        .map(toolCallId => {
          const toolCall = toolCallMap.get(toolCallId)
          if (!toolCall) return null
          consumedToolCallIds.add(toolCallId)
          return this.restoreToolCallDefinition(toolCall)
        })
        .filter((toolCall): toolCall is RestoredToolCall => toolCall !== null)

      if (assistantContent || restoredToolCalls.length > 0) {
        const assistantMessage: AgentMessage = {
          role: 'assistant',
          content: assistantContent,
        }

        if (restoredToolCalls.length > 0) {
          assistantMessage.tool_calls = restoredToolCalls
        }

        restored.push(assistantMessage)
      }

      for (const toolCallId of currentToolCallIds) {
        const toolCall = toolCallMap.get(toolCallId)
        const toolMessage = toolCall ? this.restoreToolResultMessage(toolCall) : null
        if (toolMessage) {
          restored.push(toolMessage)
        }
      }

      currentText = ''
      currentToolCallIds = []
    }

    for (const block of contentBlocks) {
      if (!block) continue

      if (block.type === 'text') {
        currentText += typeof block.content === 'string' ? block.content : ''
        continue
      }

      if (block.type === 'tool-call') {
        if (block.toolCallId && !currentToolCallIds.includes(block.toolCallId)) {
          currentToolCallIds.push(block.toolCallId)
        }
        continue
      }

      if (block.type === 'iteration-end') {
        flushCurrentTurn()
      }
    }

    flushCurrentTurn()

    const missingToolCalls = toolCalls.filter(toolCall => toolCall.id && !consumedToolCallIds.has(toolCall.id))
    const restoredMissingToolCalls = missingToolCalls
      .map(toolCall => this.restoreToolCallDefinition(toolCall))
      .filter((toolCall): toolCall is RestoredToolCall => toolCall !== null)

    if (restoredMissingToolCalls.length > 0) {
      restored.push({
        role: 'assistant',
        content: null,
        tool_calls: restoredMissingToolCalls,
      })

      for (const toolCall of missingToolCalls) {
        const toolMessage = this.restoreToolResultMessage(toolCall)
        if (toolMessage) {
          restored.push(toolMessage)
        }
      }
    }

    return restored
  }

  private restoreAssistantMessageFallback(message: SessionMessageData): AgentMessage[] {
    const restored: AgentMessage[] = []
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : []
    const assistantContent = this.normalizeRestoredAssistantContent(
      typeof message.content === 'string' ? message.content : '',
    )
    const restoredToolCalls = toolCalls
      .map(toolCall => this.restoreToolCallDefinition(toolCall))
      .filter((toolCall): toolCall is RestoredToolCall => toolCall !== null)

    if (assistantContent || restoredToolCalls.length > 0) {
      const assistantMessage: AgentMessage = {
        role: 'assistant',
        content: assistantContent,
      }

      if (restoredToolCalls.length > 0) {
        assistantMessage.tool_calls = restoredToolCalls
      }

      restored.push(assistantMessage)
    }

    for (const toolCall of toolCalls) {
      const toolMessage = this.restoreToolResultMessage(toolCall)
      if (toolMessage) {
        restored.push(toolMessage)
      }
    }

    return restored
  }

  private restoreToolCallDefinition(toolCall: SessionToolCallData): RestoredToolCall | null {
    if (!toolCall.id || !toolCall.name) {
      return null
    }

    return {
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: typeof toolCall.arguments === 'string' ? toolCall.arguments : '{}',
      },
    }
  }

  private restoreToolResultMessage(toolCall: SessionToolCallData): AgentMessage | null {
    if (!toolCall.id || !toolCall.name) {
      return null
    }

    return {
      role: 'tool',
      content: this.buildRestoredToolResultContent(toolCall),
      tool_call_id: toolCall.id,
      name: toolCall.name,
    }
  }

  private buildRestoredToolResultContent(toolCall: SessionToolCallData): string {
    const result = typeof toolCall.result === 'string' ? toolCall.result : ''
    const error = typeof toolCall.error === 'string' ? toolCall.error : ''

    if (toolCall.status === 'completed') {
      return this.truncateRestoredToolContent(
        result || `Tool ${toolCall.name || 'unknown_tool'} completed successfully without captured output.`,
      )
    }

    if (toolCall.status === 'error') {
      if (error === 'Permission denied') {
        return `Permission denied by user for: ${toolCall.name}`
      }

      return this.truncateRestoredToolContent(
        error || result || `Tool ${toolCall.name || 'unknown_tool'} failed without a captured error message.`,
      )
    }

    if (toolCall.status === 'running' || toolCall.status === 'pending') {
      const prefix = `Tool call was interrupted before completion: ${toolCall.name || 'unknown_tool'}`
      return this.truncateRestoredToolContent(
        result || error ? `${prefix}

${result || error}` : prefix,
      )
    }

    return this.truncateRestoredToolContent(
      result || error || `Tool ${toolCall.name || 'unknown_tool'} finished with an unknown status.`,
    )
  }

  private truncateRestoredToolContent(content: string): string {
    if (content.length <= MAX_RESTORED_TOOL_CONTENT_CHARS) {
      return content
    }

    return `${content.slice(0, MAX_RESTORED_TOOL_CONTENT_CHARS)}
[truncated]`
  }

  private normalizeRestoredAssistantContent(content: string): string | null {
    return content.trim().length > 0 ? content : null
  }

  private buildSystemPrompt(
    workspacePath: string | null,
    permissionMode: string,
    enabledSkills: SkillData[],
  ): string {
    const workspace = workspacePath
      ? `You are working in the directory: ${workspacePath}. All file operations should be relative to or within this workspace unless the user specifies otherwise.`
      : `No workspace directory is set. You can work with files anywhere the user specifies.`

    // Environment awareness
    const now = new Date()
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    const dateStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}, ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
    const osName = os.platform() === 'darwin' ? 'macOS' : os.platform() === 'win32' ? 'Windows' : 'Linux'
    const homeDir = os.homedir()

    // Skills section
    let skillsSection = ''
    if (enabledSkills.length > 0) {
      const skillsList = enabledSkills
        .map(s => `- **${s.displayName}** (\`@${s.name}\`): ${s.description}`)
        .join('\n')
      skillsSection = `\n\n## Available Skills\nThe user can invoke these skills by mentioning them with @. When a skill is mentioned, follow its instructions.\n${skillsList}`
    }

    return `You are Onit Agent, a highly capable AI assistant running on the user's desktop. You help users accomplish tasks by using the available tools.

Current date and time: ${dateStr}
Operating system: ${osName}
Home directory: ${homeDir}

${workspace}

Core principles:
- You represent the user and act on their behalf, never replacing their decisions
- Be transparent about what you're doing and why
- For complex tasks, break them down into clear steps using create_task_list
- Always explain your reasoning before taking actions
- Try to solve problems autonomously — only ask the user for help when you encounter truly insurmountable obstacles
- Be efficient and precise in tool usage

Current permission mode: ${permissionMode}
${permissionMode === 'plan' ? 'In Plan mode: explain every step before executing and ask for confirmation on uncertain operations.' : ''}
${permissionMode === 'accept-edit' ? 'In AcceptEdit mode: proceed with standard operations but ask for confirmation on sensitive ones.' : ''}
${permissionMode === 'full-access' ? 'In Full Access mode: execute tasks autonomously, only notify about high-risk irreversible operations.' : ''}

When providing final results, format them clearly with markdown. For code, use appropriate syntax highlighting.${skillsSection}`
  }

  private getApiUrl(apiConfig: { billingMode: string; customBaseUrl?: string; codingPlanProvider?: string }): string {
    if (apiConfig.customBaseUrl) return apiConfig.customBaseUrl
    if (apiConfig.billingMode === 'coding-plan') {
      return this.getCodingPlanUrl(apiConfig.codingPlanProvider)
    }
    return 'https://qianfan.baidubce.com/v2/chat/completions'
  }

  private getCodingPlanUrl(provider?: string): string {
    const urls: Record<string, string> = {
      qianfan: 'https://qianfan.baidubce.com/v2/coding/chat/completions',
      volcengine: 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions',
      dashscope: 'https://coding.dashscope.aliyuncs.com/v1/chat/completions',
    }
    return urls[provider || 'qianfan'] || urls.qianfan
  }

  private getCodingPlanModel(provider?: string): string {
    const models: Record<string, string> = {
      qianfan: 'qianfan-code-latest',
      volcengine: 'ark-code-latest',
      dashscope: 'qwen3.5-plus',
    }
    return models[provider || 'qianfan'] || 'qianfan-code-latest'
  }

  private async callLLM(
    agentSession: AgentSession,
    onChunk: (chunk: any) => void
  ): Promise<{ content: string; toolCalls: any[] }> {
    const url = this.getApiUrl(agentSession.apiConfig)
    const model = agentSession.apiConfig.billingMode === 'coding-plan'
      ? this.getCodingPlanModel(agentSession.apiConfig.codingPlanProvider)
      : agentSession.model

    const body = JSON.stringify({
      model,
      messages: agentSession.messages.map(m => {
        const msg: any = { role: m.role, content: m.content }
        if (m.tool_calls) msg.tool_calls = m.tool_calls
        if (m.tool_call_id) {
          msg.tool_call_id = m.tool_call_id
          msg.name = m.name
        }
        return msg
      }),
      tools: AGENT_TOOLS,
      stream: true,
      temperature: 0.7,
      max_tokens: 8192,
    })

    return new Promise((resolve, reject) => {
      if (!agentSession.isRunning) {
        reject(new Error('Agent stopped'))
        return
      }

      const parsedUrl = new URL(url)
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${agentSession.apiConfig.apiKey}`,
        },
      }

      const httpModule = parsedUrl.protocol === 'https:' ? https : http
      const req = httpModule.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errorBody = ''
          res.on('data', (chunk: Buffer) => { errorBody += chunk.toString() })
          res.on('end', () => {
            reject(new Error(`API error (${res.statusCode}): ${errorBody.substring(0, 500)}`))
          })
          res.on('error', reject)
          return
        }

        let fullContent = ''
        let toolCalls: any[] = []
        let buffer = ''

        res.on('data', (chunk: Buffer) => {
          if (!agentSession.isRunning) {
            req.destroy()
            return
          }

          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (data === '[DONE]') continue

            try {
              const parsed = JSON.parse(data)
              const delta = parsed.choices?.[0]?.delta

              if (!delta) continue

              if (delta.content) {
                fullContent += delta.content
                onChunk({ type: 'content', content: delta.content })
              }

              if (delta.reasoning_content) {
                onChunk({ type: 'thinking', content: delta.reasoning_content })
              }

              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index || 0
                  if (!toolCalls[idx]) {
                    toolCalls[idx] = {
                      id: tc.id || `call_${uuidv4().slice(0, 8)}`,
                      type: 'function',
                      function: { name: '', arguments: '' },
                    }
                  }
                  if (tc.id) toolCalls[idx].id = tc.id
                  if (tc.function?.name) toolCalls[idx].function.name += tc.function.name
                  if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
                }
              }
            } catch {
              // Skip invalid JSON chunks
            }
          }
        })

        res.on('end', () => {
          if (buffer.trim()) {
            const trimmed = buffer.trim()
            if (trimmed.startsWith('data:')) {
              const data = trimmed.slice(5).trim()
              if (data !== '[DONE]') {
                try {
                  const parsed = JSON.parse(data)
                  const delta = parsed.choices?.[0]?.delta
                  if (delta?.content) {
                    fullContent += delta.content
                    onChunk({ type: 'content', content: delta.content })
                  }
                } catch {}
              }
            }
          }
          resolve({ content: fullContent, toolCalls: toolCalls.filter(Boolean) })
        })

        res.on('error', reject)
      })

      req.on('error', reject)

      let abortHandler: (() => void) | null = null
      if (agentSession.abortController) {
        abortHandler = () => {
          req.destroy()
          reject(new Error('Agent stopped'))
        }
        agentSession.abortController.signal.addEventListener('abort', abortHandler, { once: true })
      }

      const cleanupAbortHandler = () => {
        if (abortHandler && agentSession.abortController) {
          agentSession.abortController.signal.removeEventListener('abort', abortHandler)
          abortHandler = null
        }
      }

      req.on('close', cleanupAbortHandler)

      req.write(body)
      req.end()
    })
  }

  private async requestPermission(
    agentSession: AgentSession,
    toolName: string,
    description: string,
    details: string,
    riskLevel: string
  ): Promise<boolean> {
    const mode = agentSession.permissionMode

    if (mode === 'full-access') {
      if (riskLevel === 'dangerous') {
        this.sendToRenderer('agent:stream', {
          sessionId: agentSession.sessionId,
          runId: agentSession.runId,
          chunk: { type: 'content', content: `\n> **Risk Notice:** Executing ${toolName} - ${description}\n\n` },
        })
      }
      return true
    }

    if (riskLevel === 'safe') return true

    if (mode === 'accept-edit' && agentSession.alwaysAllowedTools.has(toolName)) {
      return true
    }

    const requestId = `${uuidv4()}:${toolName}`

    return new Promise((resolve) => {
      agentSession.pendingPermissions.set(requestId, { resolve })

      this.sendToRenderer('agent:permission-request', {
        id: requestId,
        sessionId: agentSession.sessionId,
        runId: agentSession.runId,
        type: this.getPermissionType(toolName, riskLevel),
        description,
        details,
        toolName,
        showAlwaysAllow: mode === 'accept-edit',
      })

      setTimeout(() => {
        if (agentSession.pendingPermissions.has(requestId)) {
          agentSession.pendingPermissions.delete(requestId)
          resolve(false)
        }
      }, 300000)
    })
  }

  private getPermissionType(toolName: string, riskLevel: string): string {
    if (toolName === 'delete_file') return 'file-delete'
    if (toolName === 'write_file') return 'file-write'
    if (toolName === 'edit_file') return 'file-overwrite'
    if (toolName === 'execute_command') return 'command-execute'
    return riskLevel === 'dangerous' ? 'system-config' : 'file-write'
  }

  private async runAgentLoop(agentSession: AgentSession): Promise<void> {
    const MAX_ITERATIONS = 200
    let iteration = 0

    try {
      while (agentSession.isRunning && iteration < MAX_ITERATIONS) {
        iteration++

        // After 50 iterations, add a hint to encourage progress summary
        if (iteration === 51) {
          agentSession.messages.push({
            role: 'system',
            content: 'You have been running for a while. Please summarize your progress so far and outline what remains to be done. If you are stuck in a loop, try a different approach.',
          })
        }

        // Call LLM
        const { content, toolCalls } = await this.callLLM(agentSession, (chunk) => {
          this.sendToRenderer('agent:stream', {
            sessionId: agentSession.sessionId,
            runId: agentSession.runId,
            chunk,
          })
        })

        if (!agentSession.isRunning) break

        // If there's content and no tool calls, we're done
        if (toolCalls.length === 0) {
          agentSession.messages.push({ role: 'assistant', content: content || '' })
          agentSession.completionStatus = 'completed'
          break
        }

        // Add assistant message with tool calls
        agentSession.messages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls,
        })

        // Execute each tool call
        for (const tc of toolCalls) {
          if (!agentSession.isRunning) break

          const toolName = tc.function.name
          const toolArgs = tc.function.arguments

          this.sendToRenderer('agent:stream', {
            sessionId: agentSession.sessionId,
            runId: agentSession.runId,
            chunk: { type: 'tool-call-start', toolCall: { id: tc.id, name: toolName, arguments: toolArgs, status: 'running' } },
          })

          // Check permissions BEFORE executing
          let args: any = {}
          try { args = JSON.parse(toolArgs) } catch {}
          const riskLevel = getToolRiskLevel(toolName, args)

          if (riskLevel !== 'safe') {
            const description = `${toolName}: ${args.path || args.command || ''}`
            const approved = await this.requestPermission(
              agentSession, toolName, description, toolArgs, riskLevel
            )

            if (!approved) {
              agentSession.messages.push({
                role: 'tool',
                content: `Permission denied by user for: ${toolName}`,
                tool_call_id: tc.id,
                name: toolName,
              })
              this.sendToRenderer('agent:stream', {
                sessionId: agentSession.sessionId,
                runId: agentSession.runId,
                chunk: {
                  type: 'tool-call-result',
                  toolCall: { id: tc.id, name: toolName, arguments: toolArgs, status: 'error', error: 'Permission denied' },
                },
              })
              continue
            }
          }

          // Execute the tool
          const result = await executeTool(toolName, toolArgs, agentSession.workspacePath)

          // Handle task list updates
          if (toolName === 'create_task_list') {
            try {
              const tasks = JSON.parse(result.output)
              this.sendToRenderer('agent:task-update', {
                sessionId: agentSession.sessionId,
                runId: agentSession.runId,
                tasks,
              })
            } catch {}
          }

          // Update workspace files if file operations were performed
          if (['write_file', 'delete_file', 'edit_file'].includes(toolName) && agentSession.workspacePath) {
            this.updateWorkspaceFiles(agentSession)
          }

          // Add tool result to conversation (cap size to prevent memory bloat)
          agentSession.messages.push({
            role: 'tool',
            content: result.output.substring(0, 3000),
            tool_call_id: tc.id,
            name: toolName,
          })

          // Notify about tool call completion
          this.sendToRenderer('agent:stream', {
            sessionId: agentSession.sessionId,
            runId: agentSession.runId,
            chunk: {
              type: 'tool-call-result',
              toolCall: {
                id: tc.id,
                name: toolName,
                arguments: toolArgs,
                status: result.success ? 'completed' : 'error',
                result: result.output.substring(0, 2000),
                error: result.success ? undefined : result.output,
              },
            },
          })
        }

        // Send iteration-end signal for UI collapse
        this.sendToRenderer('agent:stream', {
          sessionId: agentSession.sessionId,
          runId: agentSession.runId,
          chunk: { type: 'iteration-end', iterationIndex: iteration },
        })

        // Prune old conversation history to prevent memory bloat
        // Keep system messages + last 80 messages; truncate old tool results
        if (agentSession.messages.length > 100) {
          const systemMsgs = agentSession.messages.filter(m => m.role === 'system')
          const nonSystemMsgs = agentSession.messages.filter(m => m.role !== 'system')
          const keep = nonSystemMsgs.slice(-80)
          // Truncate tool results in kept messages older than 40 messages
          for (let i = 0; i < keep.length - 40; i++) {
            if (keep[i].role === 'tool' && keep[i].content && keep[i].content!.length > 500) {
              keep[i] = { ...keep[i], content: keep[i].content!.substring(0, 500) + '\n[truncated]' }
            }
          }
          agentSession.messages = [...systemMsgs, ...keep]
        }
      }
    } catch (error: any) {
      if (error.message !== 'Agent stopped') {
        agentSession.completionStatus = 'error'
        this.sendToRenderer('agent:error', {
          sessionId: agentSession.sessionId,
          runId: agentSession.runId,
          error: error.message || 'Unknown error in agent loop',
        })
      }
    } finally {
      agentSession.isRunning = false
      if (agentSession.completionStatus !== 'error') {
        this.sendToRenderer('agent:complete', {
          sessionId: agentSession.sessionId,
          runId: agentSession.runId,
          status: agentSession.completionStatus,
        })
      }
    }
  }

  private updateWorkspaceFiles(agentSession: AgentSession): void {
    if (!agentSession.workspacePath) return
    try {
      const entries = fs.readdirSync(agentSession.workspacePath, { withFileTypes: true })
      const files = entries
        .filter((e: any) => !e.name.startsWith('.'))
        .map((e: any) => ({
          name: e.name,
          path: path.join(agentSession.workspacePath!, e.name),
          type: e.isDirectory() ? 'directory' : 'file',
        }))
      this.sendToRenderer('agent:workspace-files', {
        sessionId: agentSession.sessionId,
        runId: agentSession.runId,
        files,
      })
    } catch {}
  }
}
