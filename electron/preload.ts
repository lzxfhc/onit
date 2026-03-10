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
  setSchedulerApiConfig: (config: { billingMode: string; apiKey: string; customBaseUrl?: string }) =>
    ipcRenderer.invoke('scheduler:set-api-config', config),

  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list'),
  toggleSkill: (data: { id: string; enabled: boolean }) => ipcRenderer.invoke('skills:toggle', data),
  deleteSkill: (data: { id: string }) => ipcRenderer.invoke('skills:delete', data),
  createSkill: (data: { name: string; description: string; content: string }) => ipcRenderer.invoke('skills:create', data),
  importSkill: () => ipcRenderer.invoke('skills:import'),

  // File system
  listDirectory: (dirPath: string) => ipcRenderer.invoke('fs:list-directory', dirPath),

  // App
  getDataPath: () => ipcRenderer.invoke('app:get-data-path'),

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
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
