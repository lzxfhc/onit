import { create } from 'zustand'
import type { AppSettings, ApiConfig, PermissionMode, ScheduledTask, Skill, EvolutionData, Language } from '../types'
import { DEFAULT_SETTINGS } from '../types'

interface SkillNotification {
  id: string
  skillId: string
  skillName: string
  message: string
  timestamp: number
}

interface ScheduledTaskRunState {
  status: 'running' | 'error'
  error?: string
}

interface SettingsState {
  settings: AppSettings
  isLoggedIn: boolean
  scheduledTasks: ScheduledTask[]
  scheduledTaskRunStates: Record<string, ScheduledTaskRunState>
  permissionRequests: any[]
  skills: Skill[]
  skillNotifications: SkillNotification[]

  // Settings actions
  updateApiConfig: (config: Partial<ApiConfig>) => void
  setDefaultPermissionMode: (mode: PermissionMode) => void
  setLanguage: (language: Language) => void
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
  runScheduledTaskNow: (id: string) => Promise<boolean>

  // Skills
  loadSkills: () => Promise<void>
  toggleSkill: (id: string, enabled: boolean) => Promise<void>
  deleteSkill: (id: string) => Promise<void>
  importSkill: () => Promise<Skill | null>

  // Skills Evolution
  getSkillEvolution: (skillId: string) => Promise<EvolutionData>
  toggleSkillEvolvable: (skillId: string, evolvable: boolean) => Promise<void>
  evolveSkill: (skillId: string) => Promise<{ success: boolean; error?: string }>
  applySkillEvolution: (skillId: string) => Promise<boolean>
  rejectSkillEvolution: (skillId: string) => Promise<boolean>
  rollbackSkill: (skillId: string, version: string) => Promise<boolean>
  deleteSkillRecord: (skillId: string, recordId: string) => Promise<void>
  addSkillNotification: (notification: Omit<SkillNotification, 'id' | 'timestamp'>) => void
  dismissSkillNotification: (id: string) => void

  // Permission requests
  addPermissionRequest: (request: any) => void
  removePermissionRequest: (id: string) => void
  removePermissionRequestsForSession: (sessionId: string, runId?: string) => void
}

const SETTINGS_KEY = 'onit-settings'
const AUTO_LOGIN_DISABLED_KEY = 'onit-auto-login-disabled'

function hasUsableApiConfig(apiConfig: ApiConfig): boolean {
  if (apiConfig.billingMode === 'local-model') return Boolean(apiConfig.localModelId)
  return Boolean(apiConfig.apiKey)
}

function syncSchedulerApiConfig(apiConfig: ApiConfig): void {
  try {
    window.electronAPI.setSchedulerApiConfig({
      billingMode: apiConfig.billingMode,
      apiKey: apiConfig.apiKey,
      model: apiConfig.model,
      customBaseUrl: apiConfig.customBaseUrl,
      codingPlanProvider: apiConfig.codingPlanProvider,
      localModelId: apiConfig.localModelId,
      maxInputTokens: apiConfig.maxInputTokens,
      maxOutputTokens: apiConfig.maxOutputTokens,
    })
  } catch {}
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  isLoggedIn: false,
  scheduledTasks: [],
  scheduledTaskRunStates: {},
  permissionRequests: [],
  skills: [],
  skillNotifications: [],

  updateApiConfig: (config) => {
    const mergedConfig: ApiConfig = { ...get().settings.apiConfig, ...config }
    set(state => ({
      settings: {
        ...state.settings,
        apiConfig: mergedConfig,
      },
    }))
    get().saveSettings()
    syncSchedulerApiConfig(mergedConfig)
  },

  setDefaultPermissionMode: (mode) => {
    set(state => ({
      settings: { ...state.settings, defaultPermissionMode: mode },
    }))
    get().saveSettings()
  },

  setLanguage: (language) => {
    set(state => ({
      settings: { ...state.settings, language },
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
    try { localStorage.removeItem(AUTO_LOGIN_DISABLED_KEY) } catch {}
    syncSchedulerApiConfig(mergedConfig)
  },

  logout: () => {
    try { localStorage.setItem(AUTO_LOGIN_DISABLED_KEY, 'true') } catch {}
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
        const autoLoginDisabled = localStorage.getItem(AUTO_LOGIN_DISABLED_KEY) === 'true'
        const shouldRestoreLogin = !autoLoginDisabled && hasUsableApiConfig(settings.apiConfig)
        set({ settings, isLoggedIn: shouldRestoreLogin })
        if (shouldRestoreLogin) syncSchedulerApiConfig(settings.apiConfig)
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
      scheduledTaskRunStates: Object.fromEntries(
        Object.entries(state.scheduledTaskRunStates).filter(([taskId]) => taskId !== id),
      ),
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
    set(state => ({
      scheduledTaskRunStates: {
        ...state.scheduledTaskRunStates,
        [id]: { status: 'running' },
      },
    }))

    try {
      const started = await window.electronAPI.runScheduledTaskNow({ id })
      if (started) {
        set(state => {
          const next = { ...state.scheduledTaskRunStates }
          delete next[id]
          return { scheduledTaskRunStates: next }
        })
        await get().loadScheduledTasks()
        return true
      }

      set(state => ({
        scheduledTaskRunStates: {
          ...state.scheduledTaskRunStates,
          [id]: { status: 'error', error: 'Task could not start. Check your model and API settings.' },
        },
      }))
      return false
    } catch (err: any) {
      set(state => ({
        scheduledTaskRunStates: {
          ...state.scheduledTaskRunStates,
          [id]: { status: 'error', error: err?.message || 'Task could not start.' },
        },
      }))
      return false
    }
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

  // Skills Evolution
  getSkillEvolution: async (skillId) => {
    return window.electronAPI.getSkillEvolution({ skillId })
  },

  toggleSkillEvolvable: async (skillId, evolvable) => {
    try {
      const updated = await window.electronAPI.toggleSkillEvolvable({ skillId, evolvable })
      if (updated) {
        // Reload skills to reflect changes (fork may have created a new skill)
        await get().loadSkills()
      }
    } catch {}
  },

  evolveSkill: async (skillId) => {
    try {
      const apiConfig = get().settings.apiConfig
      return await window.electronAPI.evolveSkill({ skillId, apiConfig })
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' }
    }
  },

  applySkillEvolution: async (skillId) => {
    try {
      const result = await window.electronAPI.applySkillEvolution({ skillId })
      if (result) {
        await get().loadSkills()
      }
      return !!result
    } catch {
      return false
    }
  },

  rejectSkillEvolution: async (skillId) => {
    try {
      const result = await window.electronAPI.rejectSkillEvolution({ skillId })
      if (result) {
        await get().loadSkills()
      }
      return !!result
    } catch {
      return false
    }
  },

  rollbackSkill: async (skillId, version) => {
    try {
      const result = await window.electronAPI.rollbackSkill({ skillId, version })
      if (result) {
        await get().loadSkills()
      }
      return !!result
    } catch {
      return false
    }
  },

  deleteSkillRecord: async (skillId, recordId) => {
    try {
      await window.electronAPI.deleteSkillRecord({ skillId, recordId })
    } catch {}
  },

  addSkillNotification: (notification) => {
    const id = `sn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    set(state => ({
      skillNotifications: [...state.skillNotifications, { ...notification, id, timestamp: Date.now() }],
    }))
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      get().dismissSkillNotification(id)
    }, 5000)
  },

  dismissSkillNotification: (id) => {
    set(state => ({
      skillNotifications: state.skillNotifications.filter(n => n.id !== id),
    }))
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
