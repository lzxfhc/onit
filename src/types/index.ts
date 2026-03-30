export type BillingMode = 'coding-plan' | 'api-call' | 'local-model'

export type CodingPlanProvider = 'qianfan' | 'volcengine' | 'dashscope'

export interface CodingPlanProviderConfig {
  id: CodingPlanProvider
  name: string
  baseUrl: string
  model: string
}

export const CODING_PLAN_PROVIDERS: CodingPlanProviderConfig[] = [
  { id: 'qianfan', name: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2/coding/chat/completions', model: 'qianfan-code-latest' },
  { id: 'volcengine', name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions', model: 'ark-code-latest' },
  { id: 'dashscope', name: '阿里百炼', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1/chat/completions', model: 'qwen3.5-plus' },
]

export interface ApiConfig {
  billingMode: BillingMode
  apiKey: string
  model: string
  customBaseUrl?: string
  codingPlanProvider?: CodingPlanProvider
  localModelId?: string
  /**
   * Soft limit for prompt (input) tokens that Onit will try to stay under by
   * pruning / compressing history before sending requests.
   *
   * Note: The upstream model may have a smaller context window. Onit will fall
   * back if the provider rejects the request due to context limits.
   */
  maxInputTokens?: number
  /**
   * Requested maximum output tokens for the provider/model (passed as
   * `max_tokens`). The provider may clamp or reject overly large values.
   */
  maxOutputTokens?: number
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
  resultFilePath?: string
}

export interface ContentBlock {
  type: 'text' | 'tool-call' | 'iteration-end'
  content?: string
  toolCallId?: string
  iterationIndex?: number
}

export interface Message {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  runId?: string
  toolCalls?: ToolCall[]
  thinking?: string
  thinkingStatus?: 'thinking' | 'done'
  isStreaming?: boolean
  contentBlocks?: ContentBlock[]
  iterationIndex?: number
  /** System-generated message (hidden from UI, used for auto-report triggers) */
  isSystem?: boolean
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
  activeRunId?: string | null
  permissionMode: PermissionMode
  workspacePath: string | null
  attachedFiles: string[]
  model: string
  tasks: TaskItem[]
  workspaceFiles: WorkspaceFile[]
  sessionMemory?: SessionMemory | null
  createdAt: number
  updatedAt: number
  isBackgroundRunning: boolean
  backgroundCompleted: boolean
  hasUnviewedResult: boolean
}

export interface SessionMemory {
  content: string
  updatedAt: number
  version?: number
}

export type ScheduledFrequency = 'manual' | 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'weekdays'

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
  scheduleTime?: string
  scheduleDayOfWeek?: number
  scheduleDayOfMonth?: number
  scheduleDateTime?: string
  permissionMode?: PermissionMode
}

export interface ScheduledSessionCreatedEvent {
  taskId: string
  taskName: string
  taskPrompt: string
  sessionId: string
  runId: string
  workspacePath: string | null
  model: string
  permissionMode: PermissionMode
  triggerSource: 'manual' | 'scheduled'
  openInForeground: boolean
}

export interface PermissionRequest {
  id: string
  sessionId: string
  runId?: string
  type: 'file-write' | 'file-delete' | 'file-overwrite' | 'command-execute' | 'system-config' | 'send-message' | 'task-plan'
  description: string
  details: string
  toolName?: string
  resolve?: (approved: boolean, alwaysAllow?: boolean) => void
}

export type Language = 'zh' | 'en'

// Copilot mode types
export type AppMode = 'onit' | 'copilot'

export type CopilotTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface CopilotTask {
  id: string
  name: string
  description: string
  status: CopilotTaskStatus
  sessionId: string
  taskType: 'temporary' | 'persistent'
  topic?: string
  createdAt: number
  completedAt?: number
  summary?: string
  finalResponse?: string
  workspace?: string
  skills?: string[]
  messages?: Message[]
  sessionMemory?: SessionMemory | null
  lastRunId?: string | null
  lastAccessedAt?: number
  accessCount?: number
}

export interface AppSettings {
  apiConfig: ApiConfig
  defaultPermissionMode: PermissionMode
  maxParallelTasks: number
  theme: 'light'
  language: Language
}

// IPC Channel types
export interface IpcChannels {
  'agent:start': { sessionId: string; message: string; runId: string }
  'agent:stop': { sessionId: string }
  'agent:stream': { sessionId: string; runId: string; chunk: StreamChunk }
  'agent:complete': { sessionId: string; runId: string; status: 'completed' | 'stopped' }
  'agent:error': { sessionId: string; runId: string; error: string }
  'agent:memory-update': { sessionId: string; runId: string; memory: SessionMemory | null }
  'agent:permission-request': PermissionRequest
  'agent:permission-response': { requestId: string; approved: boolean; alwaysAllow?: boolean }
  'agent:task-update': { sessionId: string; runId: string; tasks: TaskItem[] }
  'agent:tool-call': { sessionId: string; runId: string; toolCall: ToolCall }
  'agent:workspace-files': { sessionId: string; runId: string; files: WorkspaceFile[] }
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
  // Skill Evolution
  'skills:get-evolution': { skillId: string }
  'skills:toggle-evolvable': { skillId: string; evolvable: boolean }
  'skills:evolve': { skillId: string }
  'skills:apply-evolution': { skillId: string }
  'skills:reject-evolution': { skillId: string }
  'skills:rollback': { skillId: string; version: string }
  'skills:delete-record': { skillId: string; recordId: string }
}

export type StreamChunkType =
  | 'thinking'
  | 'content'
  | 'tool-call-start'
  | 'tool-call-result'
  | 'error'
  | 'done'
  | 'iteration-end'
  | 'reconnect'

export interface StreamChunk {
  type: StreamChunkType
  content?: string
  toolCall?: ToolCall
  taskUpdate?: TaskItem[]
  iterationIndex?: number
}

// Available models
export const AVAILABLE_MODELS = [
  { id: 'qianfan-code-latest', name: 'Qianfan Code (Coding Plan)', codingPlan: true },
  { id: 'ernie-4.5-8k', name: 'ERNIE 4.5 8K', codingPlan: false },
  { id: 'ernie-4.5-128k', name: 'ERNIE 4.5 128K', codingPlan: false },
  { id: 'deepseek-v3', name: 'DeepSeek V3', codingPlan: false },
  { id: 'deepseek-r1', name: 'DeepSeek R1', codingPlan: false },
] as const

// Local model types
export interface LocalModelDef {
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

export type LocalModelStatus =
  | 'not-downloaded'
  | 'downloading'
  | 'downloaded'
  | 'loading'
  | 'ready'
  | 'error'

export interface LocalModelState {
  modelId: string
  status: LocalModelStatus
  downloadProgress?: number
  error?: string
}

export const AVAILABLE_LOCAL_MODELS: LocalModelDef[] = [
  {
    id: 'qwen3.5-4b',
    name: 'Qwen3.5-4B',
    displayName: 'Qwen3.5 4B',
    description: '通义千问3.5 4B 模型，工具调用能力强，适合8GB+内存Mac',
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
    description: '通义千问3.5 0.8B 轻量模型，体积小速度快，适合简单任务',
    fileName: 'Qwen3.5-0.8B-Q8_0.gguf',
    downloadUrl: 'https://modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF/resolve/master/Qwen3.5-0.8B-Q8_0.gguf',
    fileSize: 812_000_000,
    contextSize: 262144,
    maxInputTokens: 24000,
    maxOutputTokens: 8000,
  },
]

// Skill types
export interface Skill {
  id: string
  name: string
  displayName: string
  description: string
  version?: string
  content: string
  source: 'prebuilt' | 'user-created' | 'imported'
  enabled: boolean
  filePath: string
  createdAt: number
  // Evolution fields
  evolvable: boolean
  evolutionHints?: string[]
  usageCount: number
  lastUsedAt: number | null
  recordCount: number
  /** Skill memory — structured knowledge injected at runtime alongside the skill content. */
  memory: string | null
  pendingEvolution: boolean
}

// Skill Evolution types

/** Usage record — stores a formatted conversation log from a session where the skill was used. */
export interface UsageRecord {
  id: string
  sessionId: string
  timestamp: number
  lastUpdatedAt: number
  /** Formatted conversation log: user messages, tool call summaries, agent response summaries. */
  conversation: string
  /** Background context for this usage session. */
  context?: {
    toolsUsed?: string[]
    iterationCount?: number
  }
  /** Whether this record has been compressed via LLM summarization. */
  compressed?: boolean
}

export interface EvolutionHistoryEntry {
  timestamp: number
  /** Full memory snapshot at the time of this evolution. */
  memorySnapshot: string
  /** UsageRecord IDs consumed by this evolution. */
  recordIds: string[]
  summary: string
}

export interface PendingEvolution {
  /** The proposed new memory content (replaces current memory entirely). */
  proposedMemory: string
  /** The previous memory content (for diff display). */
  previousMemory: string
  summary: string
  recordsUsed: string[]
  generatedAt: number
}

export interface EvolutionData {
  skillId: string
  records: UsageRecord[]
  /** Skill memory — structured knowledge injected at runtime. */
  memory: string | null
  history: EvolutionHistoryEntry[]
  pendingEvolution: PendingEvolution | null
  /** Timestamp of last auto-analysis (to avoid repeated triggers). */
  lastAutoAnalyzedAt?: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiConfig: {
    billingMode: 'coding-plan',
    apiKey: '',
    model: 'qianfan-code-latest',
    codingPlanProvider: 'qianfan',
    maxInputTokens: 95000,
    maxOutputTokens: 65000,
  },
  defaultPermissionMode: 'accept-edit',
  maxParallelTasks: 3,
  theme: 'light',
  language: 'zh',
}
