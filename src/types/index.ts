export type BillingMode = 'coding-plan' | 'api-call'

export interface ApiConfig {
  billingMode: BillingMode
  apiKey: string
  model: string
  customBaseUrl?: string
}

export type PermissionMode = 'plan' | 'accept-edit' | 'full-access'

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ToolCall {
  id: string
  name: string
  arguments: string
  status: 'pending' | 'running' | 'completed' | 'error'
  result?: string
  error?: string
}

export interface Message {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  toolCalls?: ToolCall[]
  thinking?: string
  isStreaming?: boolean
}

export type SessionStatus = 'idle' | 'running' | 'completed' | 'error' | 'waiting-input'

export interface TaskItem {
  id: string
  title: string
  status: 'pending' | 'in-progress' | 'completed'
}

export interface WorkspaceFile {
  name: string
  path: string
  type: 'file' | 'directory'
  isTemp?: boolean
}

export interface Session {
  id: string
  name: string
  messages: Message[]
  status: SessionStatus
  permissionMode: PermissionMode
  workspacePath: string | null
  attachedFiles: string[]
  model: string
  tasks: TaskItem[]
  workspaceFiles: WorkspaceFile[]
  createdAt: number
  updatedAt: number
  isBackgroundRunning: boolean
  backgroundCompleted: boolean
  hasUnviewedResult: boolean
}

export type ScheduledFrequency = 'manual' | 'hourly' | 'daily' | 'weekly' | 'weekdays'

export interface ScheduledTask {
  id: string
  name: string
  description: string
  taskPrompt: string
  model: string
  workspacePath: string | null
  frequency: ScheduledFrequency
  enabled: boolean
  lastRun: number | null
  nextRun: number | null
  createdAt: number
}

export interface PermissionRequest {
  id: string
  sessionId: string
  type: 'file-write' | 'file-delete' | 'file-overwrite' | 'command-execute' | 'system-config' | 'send-message' | 'task-plan'
  description: string
  details: string
  toolName?: string
  resolve?: (approved: boolean, alwaysAllow?: boolean) => void
}

export interface AppSettings {
  apiConfig: ApiConfig
  defaultPermissionMode: PermissionMode
  maxParallelTasks: number
  theme: 'light'
}

// IPC Channel types
export interface IpcChannels {
  'agent:start': { sessionId: string; message: string }
  'agent:stop': { sessionId: string }
  'agent:stream': { sessionId: string; chunk: StreamChunk }
  'agent:complete': { sessionId: string }
  'agent:error': { sessionId: string; error: string }
  'agent:permission-request': PermissionRequest
  'agent:permission-response': { requestId: string; approved: boolean; alwaysAllow?: boolean }
  'agent:task-update': { sessionId: string; tasks: TaskItem[] }
  'agent:tool-call': { sessionId: string; toolCall: ToolCall }
  'agent:workspace-files': { sessionId: string; files: WorkspaceFile[] }
  'dialog:select-folder': void
  'dialog:select-files': void
  'scheduler:create': ScheduledTask
  'scheduler:update': ScheduledTask
  'scheduler:delete': { id: string }
  'scheduler:toggle': { id: string; enabled: boolean }
  'scheduler:run-now': { id: string }
  'scheduler:list': void
  'sessions:save': Session
  'sessions:load': void
  'sessions:delete': { id: string }
}

export type StreamChunkType = 'thinking' | 'content' | 'tool-call-start' | 'tool-call-result' | 'error' | 'done'

export interface StreamChunk {
  type: StreamChunkType
  content?: string
  toolCall?: ToolCall
  taskUpdate?: TaskItem[]
}

// Available models
export const AVAILABLE_MODELS = [
  { id: 'qianfan-code-latest', name: 'Qianfan Code (Coding Plan)', codingPlan: true },
  { id: 'ernie-4.5-8k', name: 'ERNIE 4.5 8K', codingPlan: false },
  { id: 'ernie-4.5-128k', name: 'ERNIE 4.5 128K', codingPlan: false },
  { id: 'deepseek-v3', name: 'DeepSeek V3', codingPlan: false },
  { id: 'deepseek-r1', name: 'DeepSeek R1', codingPlan: false },
] as const

export const DEFAULT_SETTINGS: AppSettings = {
  apiConfig: {
    billingMode: 'coding-plan',
    apiKey: '',
    model: 'qianfan-code-latest',
  },
  defaultPermissionMode: 'accept-edit',
  maxParallelTasks: 3,
  theme: 'light',
}
