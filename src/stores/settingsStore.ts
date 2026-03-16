import { create } from 'zustand'
import type { AppSettings, ApiConfig, PermissionMode, ScheduledTask, Skill } from '../types'
import { DEFAULT_SETTINGS } from '../types'

interface SettingsState {
  settings: AppSettings
  isLoggedIn: boolean
  scheduledTasks: ScheduledTask[]
  permissionRequests: any[]
  skills: Skill[]

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

  // Skills
  loadSkills: () => Promise<void>
  toggleSkill: (id: string, enabled: boolean) => Promise<void>
  deleteSkill: (id: string) => Promise<void>
  importSkill: () => Promise<Skill | null>

  // Permission requests
  addPermissionRequest: (request: any) => void
  removePermissionRequest: (id: string) => void
  removePermissionRequestsForSession: (sessionId: string, runId?: string) => void
}

const SETTINGS_KEY = 'onit-settings'

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  isLoggedIn: false,
  scheduledTasks: [],
  permissionRequests: [],
  skills: [],

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
    const mergedConfig: ApiConfig = {
      ...DEFAULT_SETTINGS.apiConfig,
      ...get().settings.apiConfig,
      ...config,
    }
    set(state => ({
      isLoggedIn: true,
      settings: { ...state.settings, apiConfig: mergedConfig },
    }))
    get().saveSettings()
    // Sync API config to scheduler
    try {
      window.electronAPI.setSchedulerApiConfig({
        billingMode: mergedConfig.billingMode,
        apiKey: mergedConfig.apiKey,
        customBaseUrl: mergedConfig.customBaseUrl,
        codingPlanProvider: mergedConfig.codingPlanProvider,
      })
    } catch {}
  },

  logout: () => {
    set({ isLoggedIn: false })
  },

  loadSettings: () => {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<AppSettings>
        // Merge with defaults so newly-added fields always have sane values.
        const settings: AppSettings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          apiConfig: {
            ...DEFAULT_SETTINGS.apiConfig,
            ...(parsed.apiConfig || {}),
          },
        }
        // Load settings but don't auto-login — always show mode selection on startup
        set({ settings, isLoggedIn: false })
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

  loadSkills: async () => {
    try {
      const skills = await window.electronAPI.listSkills()
      set({ skills })
    } catch {
      // Ignore
    }
  },

  toggleSkill: async (id, enabled) => {
    try {
      await window.electronAPI.toggleSkill({ id, enabled })
      set(state => ({
        skills: state.skills.map(s => s.id === id ? { ...s, enabled } : s),
      }))
    } catch {}
  },

  deleteSkill: async (id) => {
    try {
      await window.electronAPI.deleteSkill({ id })
      set(state => ({
        skills: state.skills.filter(s => s.id !== id),
      }))
    } catch {}
  },

  importSkill: async () => {
    try {
      const skill = await window.electronAPI.importSkill()
      if (skill) {
        set(state => ({
          skills: [...state.skills, skill],
        }))
        return skill
      }
      return null
    } catch {
      return null
    }
  },

  addPermissionRequest: (request) => {
    set(state => ({
      permissionRequests: state.permissionRequests.some(r => r.id === request.id)
        ? state.permissionRequests
        : [...state.permissionRequests, request],
    }))
  },

  removePermissionRequest: (id) => {
    set(state => ({
      permissionRequests: state.permissionRequests.filter(r => r.id !== id),
    }))
  },

  removePermissionRequestsForSession: (sessionId, runId) => {
    set(state => ({
      permissionRequests: state.permissionRequests.filter(request => {
        if (request.sessionId !== sessionId) return true
        if (!runId) return false
        return request.runId && request.runId !== runId
      }),
    }))
  },
}))
