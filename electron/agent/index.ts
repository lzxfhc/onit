import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { URL } from 'url'
import { v4 as uuidv4 } from 'uuid'
import { executeTool, AGENT_TOOLS, getToolRiskLevel } from './tools'
import { AgentMessage } from './types'

interface AgentSession {
  sessionId: string
  messages: AgentMessage[]
  abortController: AbortController | null
  isRunning: boolean
  permissionMode: string
  workspacePath: string | null
  model: string
  apiConfig: {
    billingMode: string
    apiKey: string
    customBaseUrl?: string
  }
  alwaysAllowedTools: Set<string>
  pendingPermissions: Map<string, { resolve: (approved: boolean) => void }>
}

export class AgentManager {
  private sessions: Map<string, AgentSession> = new Map()
  private sendToRenderer: (channel: string, data: any) => void

  constructor(sendToRenderer: (channel: string, data: any) => void) {
    this.sendToRenderer = sendToRenderer
  }

  async startAgent(sessionId: string, userMessage: string, sessionData: any): Promise<boolean> {
    let agentSession = this.sessions.get(sessionId)

    if (agentSession?.isRunning) {
      // Interrupt current run - stop it, then start new one
      this.stopAgent(sessionId)
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    const apiConfig = sessionData.apiConfig || {}

    // Build the system prompt
    const systemPrompt = this.buildSystemPrompt(sessionData.workspacePath, sessionData.permissionMode)

    // Restore conversation history from session
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt }
    ]

    // Add existing messages from session (convert from renderer format)
    if (sessionData.messages) {
      for (const msg of sessionData.messages) {
        if (msg.role === 'user') {
          messages.push({ role: 'user', content: msg.content })
        } else if (msg.role === 'assistant' && msg.content) {
          messages.push({ role: 'assistant', content: msg.content })
        }
      }
    }

    // Add the new user message
    messages.push({ role: 'user', content: userMessage })

    agentSession = {
      sessionId,
      messages,
      abortController: new AbortController(),
      isRunning: true,
      permissionMode: sessionData.permissionMode || 'accept-edit',
      workspacePath: sessionData.workspacePath,
      model: sessionData.model || 'qianfan-code-latest',
      apiConfig: {
        billingMode: apiConfig.billingMode || 'coding-plan',
        apiKey: apiConfig.apiKey || '',
        customBaseUrl: apiConfig.customBaseUrl,
      },
      alwaysAllowedTools: agentSession?.alwaysAllowedTools || new Set(),
      pendingPermissions: new Map(),
    }

    this.sessions.set(sessionId, agentSession)

    // Run the agent loop asynchronously
    this.runAgentLoop(agentSession).catch(error => {
      this.sendToRenderer('agent:error', {
        sessionId,
        error: error.message || 'Unknown agent error',
      })
    })

    return true
  }

  stopAgent(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.isRunning = false
      session.abortController?.abort()
      session.abortController = null
      // Resolve any pending permissions with denied
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
          // Extract tool name from requestId format
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

  private buildSystemPrompt(workspacePath: string | null, permissionMode: string): string {
    const workspace = workspacePath
      ? `You are working in the directory: ${workspacePath}. All file operations should be relative to or within this workspace unless the user specifies otherwise.`
      : `No workspace directory is set. You can work with files anywhere the user specifies.`

    return `You are Onit Agent, a highly capable AI assistant running on the user's Mac desktop. You help users accomplish tasks by using the available tools.

${workspace}

Core principles:
- You represent the user and act on their behalf, never replacing their decisions
- Be transparent about what you're doing and why
- For complex tasks, break them down into clear steps using create_task_list
- Always explain your reasoning before taking actions
- If something is unclear, ask for clarification
- Be efficient and precise in tool usage

Current permission mode: ${permissionMode}
${permissionMode === 'plan' ? 'In Plan mode: explain every step before executing and ask for confirmation on uncertain operations.' : ''}
${permissionMode === 'accept-edit' ? 'In AcceptEdit mode: proceed with standard operations but ask for confirmation on sensitive ones.' : ''}
${permissionMode === 'full-access' ? 'In Full Access mode: execute tasks autonomously, only notify about high-risk irreversible operations.' : ''}

When providing final results, format them clearly with markdown. For code, use appropriate syntax highlighting.`
  }

  private getApiUrl(apiConfig: { billingMode: string; customBaseUrl?: string }): string {
    if (apiConfig.customBaseUrl) return apiConfig.customBaseUrl
    if (apiConfig.billingMode === 'coding-plan') {
      return 'https://qianfan.baidubce.com/v2/coding/chat/completions'
    }
    return 'https://qianfan.baidubce.com/v2/chat/completions'
  }

  private async callLLM(
    agentSession: AgentSession,
    onChunk: (chunk: any) => void
  ): Promise<{ content: string; toolCalls: any[] }> {
    const url = this.getApiUrl(agentSession.apiConfig)
    const model = agentSession.apiConfig.billingMode === 'coding-plan'
      ? 'qianfan-code-latest'
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
        // Handle non-200 status codes
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

              // Handle content
              if (delta.content) {
                fullContent += delta.content
                onChunk({ type: 'content', content: delta.content })
              }

              // Handle thinking/reasoning
              if (delta.reasoning_content) {
                onChunk({ type: 'thinking', content: delta.reasoning_content })
              }

              // Handle tool calls
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
          // Process remaining buffer
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

      // Handle abort
      if (agentSession.abortController) {
        agentSession.abortController.signal.addEventListener('abort', () => {
          req.destroy()
          reject(new Error('Agent stopped'))
        })
      }

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

    // Full access: auto-approve everything except dangerous operations
    if (mode === 'full-access') {
      if (riskLevel === 'dangerous') {
        // Just notify, still execute
        this.sendToRenderer('agent:stream', {
          sessionId: agentSession.sessionId,
          chunk: { type: 'content', content: `\n> **Risk Notice:** Executing ${toolName} - ${description}\n\n` },
        })
      }
      return true
    }

    // Safe operations: always auto-approve
    if (riskLevel === 'safe') return true

    // AcceptEdit mode: check always-allowed list
    if (mode === 'accept-edit' && agentSession.alwaysAllowedTools.has(toolName)) {
      return true
    }

    // Need to ask user
    const requestId = `${uuidv4()}:${toolName}`

    return new Promise((resolve) => {
      agentSession.pendingPermissions.set(requestId, { resolve })

      this.sendToRenderer('agent:permission-request', {
        id: requestId,
        sessionId: agentSession.sessionId,
        type: this.getPermissionType(toolName, riskLevel),
        description,
        details,
        toolName,
        showAlwaysAllow: mode === 'accept-edit',
      })

      // Timeout after 5 minutes
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
    const MAX_ITERATIONS = 30
    let iteration = 0

    try {
      while (agentSession.isRunning && iteration < MAX_ITERATIONS) {
        iteration++

        // Call LLM
        const { content, toolCalls } = await this.callLLM(agentSession, (chunk) => {
          this.sendToRenderer('agent:stream', {
            sessionId: agentSession.sessionId,
            chunk,
          })
        })

        if (!agentSession.isRunning) break

        // If there's content and no tool calls, we're done
        if (toolCalls.length === 0) {
          // Add assistant message to history
          agentSession.messages.push({ role: 'assistant', content: content || '' })
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

          // Notify about tool call start
          this.sendToRenderer('agent:tool-call', {
            sessionId: agentSession.sessionId,
            toolCall: {
              id: tc.id,
              name: toolName,
              arguments: toolArgs,
              status: 'running',
            },
          })

          this.sendToRenderer('agent:stream', {
            sessionId: agentSession.sessionId,
            chunk: { type: 'tool-call-start', toolCall: { id: tc.id, name: toolName, arguments: toolArgs, status: 'running' } },
          })

          // Check permissions BEFORE executing for non-safe operations
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
                chunk: {
                  type: 'tool-call-result',
                  toolCall: { id: tc.id, name: toolName, arguments: toolArgs, status: 'error', error: 'Permission denied' },
                },
              })
              continue
            }
          }

          // Execute the tool (after permission is granted)
          const result = await executeTool(toolName, toolArgs, agentSession.workspacePath)

          // Handle task list updates
          if (toolName === 'create_task_list') {
            try {
              const tasks = JSON.parse(result.output)
              this.sendToRenderer('agent:task-update', {
                sessionId: agentSession.sessionId,
                tasks,
              })
            } catch {}
          }

          // Update workspace files if file operations were performed
          if (['write_file', 'delete_file', 'edit_file'].includes(toolName) && agentSession.workspacePath) {
            this.updateWorkspaceFiles(agentSession)
          }

          // Add tool result to conversation
          agentSession.messages.push({
            role: 'tool',
            content: result.output.substring(0, 10000),
            tool_call_id: tc.id,
            name: toolName,
          })

          // Notify about tool call completion
          this.sendToRenderer('agent:stream', {
            sessionId: agentSession.sessionId,
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
      }
    } catch (error: any) {
      if (error.message !== 'Agent stopped') {
        this.sendToRenderer('agent:error', {
          sessionId: agentSession.sessionId,
          error: error.message || 'Unknown error in agent loop',
        })
      }
    } finally {
      agentSession.isRunning = false
      this.sendToRenderer('agent:complete', {
        sessionId: agentSession.sessionId,
      })
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
        files,
      })
    } catch {}
  }
}
