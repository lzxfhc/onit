import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // Dialog
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  selectFiles: () => ipcRenderer.invoke('dialog:select-files'),

  // Agent
  startAgent: (data: { sessionId: string; message: string; runId: string; session: any }) =>
    ipcRenderer.invoke('agent:start', data),
  stopAgent: (data: { sessionId: string }) =>
    ipcRenderer.invoke('agent:stop', data),
  sendPermissionResponse: (data: { requestId: string; approved: boolean; alwaysAllow?: boolean }) =>
    ipcRenderer.send('agent:permission-response', data),

  // Sessions
  saveSessions: (session: any) => ipcRenderer.invoke('sessions:save', session),
  loadSessions: () => ipcRenderer.invoke('sessions:load'),
  deleteSession: (data: { id: string }) => ipcRenderer.invoke('sessions:delete', data),

  // Scheduler
  listScheduledTasks: () => ipcRenderer.invoke('scheduler:list'),
  createScheduledTask: (task: any) => ipcRenderer.invoke('scheduler:create', task),
  updateScheduledTask: (task: any) => ipcRenderer.invoke('scheduler:update', task),
  deleteScheduledTask: (data: { id: string }) => ipcRenderer.invoke('scheduler:delete', data),
  toggleScheduledTask: (data: { id: string; enabled: boolean }) => ipcRenderer.invoke('scheduler:toggle', data),
  runScheduledTaskNow: (data: { id: string }) => ipcRenderer.invoke('scheduler:run-now', data),
  setSchedulerApiConfig: (config: {
    billingMode: string
    apiKey: string
    model?: string
    customBaseUrl?: string
    codingPlanProvider?: string
    localModelId?: string
    maxInputTokens?: number
    maxOutputTokens?: number
  }) =>
    ipcRenderer.invoke('scheduler:set-api-config', config),

  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list'),
  toggleSkill: (data: { id: string; enabled: boolean }) => ipcRenderer.invoke('skills:toggle', data),
  deleteSkill: (data: { id: string }) => ipcRenderer.invoke('skills:delete', data),
  createSkill: (data: { name: string; description: string; content: string }) => ipcRenderer.invoke('skills:create', data),
  importSkill: () => ipcRenderer.invoke('skills:import'),

  // Skills Evolution
  getSkillEvolution: (data: { skillId: string }) => ipcRenderer.invoke('skills:get-evolution', data),
  toggleSkillEvolvable: (data: { skillId: string; evolvable: boolean }) => ipcRenderer.invoke('skills:toggle-evolvable', data),
  evolveSkill: (data: { skillId: string; apiConfig: any }) => ipcRenderer.invoke('skills:evolve', data),
  applySkillEvolution: (data: { skillId: string }) => ipcRenderer.invoke('skills:apply-evolution', data),
  rejectSkillEvolution: (data: { skillId: string }) => ipcRenderer.invoke('skills:reject-evolution', data),
  rollbackSkill: (data: { skillId: string; version: string }) => ipcRenderer.invoke('skills:rollback', data),
  deleteSkillRecord: (data: { skillId: string; recordId: string }) => ipcRenderer.invoke('skills:delete-record', data),

  // Local model
  getLocalModelStatus: (data?: { modelId?: string }) => ipcRenderer.invoke('local-model:status', data),
  downloadLocalModel: (data: { modelId: string }) => ipcRenderer.invoke('local-model:download', data),
  cancelLocalModelDownload: () => ipcRenderer.invoke('local-model:cancel-download'),
  deleteLocalModel: (data: { modelId: string }) => ipcRenderer.invoke('local-model:delete', data),
  loadLocalModel: (data: { modelId: string }) => ipcRenderer.invoke('local-model:load', data),
  unloadLocalModel: () => ipcRenderer.invoke('local-model:unload'),

  // File system
  listDirectory: (dirPath: string) => ipcRenderer.invoke('fs:list-directory', dirPath),

  // App
  getDataPath: () => ipcRenderer.invoke('app:get-data-path'),
  getPlatform: () => process.platform,

  // Events
  onAgentStream: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('agent:stream', listener)
    return () => ipcRenderer.removeListener('agent:stream', listener)
  },
  onAgentComplete: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('agent:complete', listener)
    return () => ipcRenderer.removeListener('agent:complete', listener)
  },
  onAgentError: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('agent:error', listener)
    return () => ipcRenderer.removeListener('agent:error', listener)
  },
  onAgentMemoryUpdate: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('agent:memory-update', listener)
    return () => ipcRenderer.removeListener('agent:memory-update', listener)
  },
  onPermissionRequest: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('agent:permission-request', listener)
    return () => ipcRenderer.removeListener('agent:permission-request', listener)
  },
  onTaskUpdate: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('agent:task-update', listener)
    return () => ipcRenderer.removeListener('agent:task-update', listener)
  },
  onToolCall: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('agent:tool-call', listener)
    return () => ipcRenderer.removeListener('agent:tool-call', listener)
  },
  onWorkspaceFiles: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('agent:workspace-files', listener)
    return () => ipcRenderer.removeListener('agent:workspace-files', listener)
  },
  onSchedulerEvent: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('scheduler:event', listener)
    return () => ipcRenderer.removeListener('scheduler:event', listener)
  },
  onSchedulerSessionCreated: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('scheduler:session-created', listener)
    return () => ipcRenderer.removeListener('scheduler:session-created', listener)
  },
  onLocalModelProgress: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('local-model:download-progress', listener)
    return () => ipcRenderer.removeListener('local-model:download-progress', listener)
  },
  onLocalModelStatusChange: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('local-model:status-change', listener)
    return () => ipcRenderer.removeListener('local-model:status-change', listener)
  },

  // Copilot
  startCopilot: (data: { message: string; runId: string; apiConfig: any; messages?: any[] }) =>
    ipcRenderer.invoke('copilot:start', data),
  stopCopilot: (data?: any) =>
    ipcRenderer.invoke('copilot:stop', data),
  loadCopilotData: () =>
    ipcRenderer.invoke('copilot:load'),
  saveCopilotData: (data: { messages: any[]; tasks: any[] }) =>
    ipcRenderer.invoke('copilot:save', data),

  // Copilot Events
  onCopilotStream: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('copilot:stream', listener)
    return () => ipcRenderer.removeListener('copilot:stream', listener)
  },
  onCopilotComplete: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('copilot:complete', listener)
    return () => ipcRenderer.removeListener('copilot:complete', listener)
  },
  onCopilotError: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('copilot:error', listener)
    return () => ipcRenderer.removeListener('copilot:error', listener)
  },
  onCopilotTaskEvent: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('copilot:task-event', listener)
    return () => ipcRenderer.removeListener('copilot:task-event', listener)
  },
  onCopilotTaskResult: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('copilot:task-result', listener)
    return () => ipcRenderer.removeListener('copilot:task-result', listener)
  },
  onCopilotAutoReport: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('copilot:auto-report', listener)
    return () => ipcRenderer.removeListener('copilot:auto-report', listener)
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
