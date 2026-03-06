import { create } from 'zustand'
import type { AppSettings, ApiConfig, PermissionMode, ScheduledTask } from '../types'
import { DEFAULT_SETTINGS } from '../types'

interface SettingsState {
  settings: AppSettings
  isLoggedIn: boolean
  scheduledTasks: ScheduledTask[]
  permissionRequests: any[]

  // Settings actions
  updateApiConfig: (config: Partial<ApiConfig>) => void
  setDefaultPermissionMode: (mode: PermissionMode) => void
  login: (config: ApiConfig) => void
  logout: () => void
  loadSettings: () => void
  saveSettings: () => void

  // Scheduled tasks
  loadScheduledTasks: () => Promise<void>
  addScheduledTask: (task: any) => Promise<ScheduledTask>
  updateScheduledTask: (task: ScheduledTask) => Promise<void>
  removeScheduledTask: (id: string) => Promise<void>
  toggleScheduledTask: (id: string, enabled: boolean) => Promise<void>
  runScheduledTaskNow: (id: string) => Promise<void>

  // Permission requests
  addPermissionRequest: (request: any) => void
  removePermissionRequest: (id: string) => void
}

const SETTINGS_KEY = 'onit-settings'

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  isLoggedIn: false,
  scheduledTasks: [],
  permissionRequests: [],

  updateApiConfig: (config) => {
    set(state => ({
      settings: {
        ...state.settings,
        apiConfig: { ...state.settings.apiConfig, ...config },
      },
    }))
    get().saveSettings()
  },

  setDefaultPermissionMode: (mode) => {
    set(state => ({
      settings: { ...state.settings, defaultPermissionMode: mode },
    }))
    get().saveSettings()
  },

  login: (config) => {
    set(state => ({
      isLoggedIn: true,
      settings: { ...state.settings, apiConfig: config },
    }))
    get().saveSettings()
  },

  logout: () => {
    set({ isLoggedIn: false })
  },

  loadSettings: () => {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY)
      if (stored) {
        const settings = JSON.parse(stored) as AppSettings
        const isLoggedIn = !!settings.apiConfig.apiKey
        set({ settings, isLoggedIn })
      }
    } catch {
      // Use defaults
    }
  },

  saveSettings: () => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(get().settings))
    } catch {
      // Ignore storage errors
    }
  },

  loadScheduledTasks: async () => {
    try {
      const tasks = await window.electronAPI.listScheduledTasks()
      set({ scheduledTasks: tasks })
    } catch {
      // Ignore
    }
  },

  addScheduledTask: async (taskData) => {
    const task = await window.electronAPI.createScheduledTask(taskData)
    set(state => ({
      scheduledTasks: [task, ...state.scheduledTasks],
    }))
    return task
  },

  updateScheduledTask: async (task) => {
    await window.electronAPI.updateScheduledTask(task)
    set(state => ({
      scheduledTasks: state.scheduledTasks.map(t => t.id === task.id ? task : t),
    }))
  },

  removeScheduledTask: async (id) => {
    await window.electronAPI.deleteScheduledTask({ id })
    set(state => ({
      scheduledTasks: state.scheduledTasks.filter(t => t.id !== id),
    }))
  },

  toggleScheduledTask: async (id, enabled) => {
    const result = await window.electronAPI.toggleScheduledTask({ id, enabled })
    if (result) {
      set(state => ({
        scheduledTasks: state.scheduledTasks.map(t => t.id === id ? result : t),
      }))
    }
  },

  runScheduledTaskNow: async (id) => {
    await window.electronAPI.runScheduledTaskNow({ id })
  },

  addPermissionRequest: (request) => {
    set(state => ({
      permissionRequests: [...state.permissionRequests, request],
    }))
  },

  removePermissionRequest: (id) => {
    set(state => ({
      permissionRequests: state.permissionRequests.filter(r => r.id !== id),
    }))
  },
}))
