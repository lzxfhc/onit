import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { AgentManager } from './agent/index'
import { SchedulerManager } from './agent/scheduler'
import { SkillManager } from './agent/skills'
import { SkillEvolutionManager } from './agent/skill-evolution'
import { LocalModelManager } from './local-model/index'

let mainWindow: BrowserWindow | null = null
let agentManager: AgentManager
let schedulerManager: SchedulerManager
let skillManager: SkillManager
let skillEvolutionManager: SkillEvolutionManager
let localModelManager: LocalModelManager

const DATA_DIR = path.join(app.getPath('userData'), 'onit-data')
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
const SCHEDULED_DIR = path.join(DATA_DIR, 'scheduled')
const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts')
const MODELS_DIR = path.join(DATA_DIR, 'models')
const USER_SKILLS_DIR = path.join(DATA_DIR, 'skills', 'user')
const IMPORTED_SKILLS_DIR = path.join(DATA_DIR, 'skills', 'imported')

function getPrebuiltSkillsDir(): string {
  // In packaged app: resources/skills/
  // In dev: __dirname is dist-electron/, skills source is at electron/skills/
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'skills')
  }
  return path.join(__dirname, '..', 'electron', 'skills')
}

function ensureDirectories() {
  for (const dir of [DATA_DIR, SESSIONS_DIR, SCHEDULED_DIR, ARTIFACTS_DIR, MODELS_DIR, USER_SKILLS_DIR, IMPORTED_SKILLS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
}

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

function createWindow() {
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#FAFAFA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  }

  if (isMac) {
    windowOptions.titleBarStyle = 'hiddenInset'
    windowOptions.trafficLightPosition = { x: 16, y: 16 }
  } else if (isWin) {
    windowOptions.titleBarStyle = 'hidden'
    windowOptions.titleBarOverlay = {
      color: '#FAFAFA',
      symbolColor: '#1A1A2E',
      height: 48,
    }
  }

  mainWindow = new BrowserWindow(windowOptions)

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupIPC() {
  // Dialog: select folder
  ipcMain.handle('dialog:select-folder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Workspace Folder',
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  // Dialog: select files
  ipcMain.handle('dialog:select-files', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Select Files to Attach',
    })
    if (result.canceled) return []
    return result.filePaths
  })

  // Agent: start — inject enabled skills
  ipcMain.handle('agent:start', async (_event, data: { sessionId: string; message: string; runId: string; session: any }) => {
    const enabledSkills = skillManager.getEnabledSkills().map(s => ({
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      content: s.content,
      memory: s.memory,
    }))
    return agentManager.startAgent(data.sessionId, data.message, data.runId, {
      ...data.session,
      enabledSkills,
    })
  })

  // Agent: stop
  ipcMain.handle('agent:stop', async (_event, data: { sessionId: string }) => {
    return agentManager.stopAgent(data.sessionId)
  })

  // Agent: permission response
  ipcMain.on('agent:permission-response', (_event, data: { requestId: string; approved: boolean; alwaysAllow?: boolean }) => {
    agentManager.handlePermissionResponse(data.requestId, data.approved, data.alwaysAllow)
  })

  // Sessions: save
  ipcMain.handle('sessions:save', async (_event, session: any) => {
    const filePath = path.join(SESSIONS_DIR, `${session.id}.json`)
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8')
    return true
  })

  // Sessions: load all
  ipcMain.handle('sessions:load', async () => {
    if (!fs.existsSync(SESSIONS_DIR)) return []
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
    return files.map(f => {
      const content = fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8')
      return JSON.parse(content)
    }).sort((a, b) => b.updatedAt - a.updatedAt)
  })

  // Sessions: delete
  ipcMain.handle('sessions:delete', async (_event, data: { id: string }) => {
    const filePath = path.join(SESSIONS_DIR, `${data.id}.json`)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return true
  })

  // Scheduler: CRUD
  ipcMain.handle('scheduler:list', async () => {
    return schedulerManager.listTasks()
  })

  ipcMain.handle('scheduler:create', async (_event, task: any) => {
    return schedulerManager.createTask(task)
  })

  ipcMain.handle('scheduler:update', async (_event, task: any) => {
    return schedulerManager.updateTask(task)
  })

  ipcMain.handle('scheduler:delete', async (_event, data: { id: string }) => {
    return schedulerManager.deleteTask(data.id)
  })

  ipcMain.handle('scheduler:toggle', async (_event, data: { id: string; enabled: boolean }) => {
    return schedulerManager.toggleTask(data.id, data.enabled)
  })

  ipcMain.handle('scheduler:run-now', async (_event, data: { id: string }) => {
    return schedulerManager.runTaskNow(data.id, (channel, eventData) => {
      mainWindow?.webContents.send(channel, eventData)
    })
  })

  // Scheduler: set API config
  ipcMain.handle('scheduler:set-api-config', async (_event, config: {
    billingMode: string
    apiKey: string
    customBaseUrl?: string
    codingPlanProvider?: string
    localModelId?: string
    maxInputTokens?: number
    maxOutputTokens?: number
  }) => {
    schedulerManager.setApiConfig(config)
    return true
  })

  // Skills: list
  ipcMain.handle('skills:list', async () => {
    return skillManager.listSkills()
  })

  // Skills: toggle
  ipcMain.handle('skills:toggle', async (_event, data: { id: string; enabled: boolean }) => {
    return skillManager.toggleSkill(data.id, data.enabled)
  })

  // Skills: delete
  ipcMain.handle('skills:delete', async (_event, data: { id: string }) => {
    return skillManager.deleteSkill(data.id)
  })

  // Skills: create
  ipcMain.handle('skills:create', async (_event, data: { name: string; description: string; content: string }) => {
    return skillManager.createSkill(data.name, data.description, data.content)
  })

  // Skills: import (opens native file dialog)
  ipcMain.handle('skills:import', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Import Skill',
      filters: [
        { name: 'Skill Files', extensions: ['md', 'skill'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return skillManager.importSkill(result.filePaths[0])
  })

  // Skills Evolution: get evolution data
  ipcMain.handle('skills:get-evolution', async (_event, data: { skillId: string }) => {
    return skillManager.getEvolutionData(data.skillId)
  })

  // Skills Evolution: toggle evolvable
  ipcMain.handle('skills:toggle-evolvable', async (_event, data: { skillId: string; evolvable: boolean }) => {
    return skillManager.toggleEvolvable(data.skillId, data.evolvable)
  })

  // Skills Evolution: synthesize evolution
  ipcMain.handle('skills:evolve', async (_event, data: { skillId: string; apiConfig: any }) => {
    return skillEvolutionManager.synthesizeEvolution(data.skillId, data.apiConfig)
  })

  // Skills Evolution: apply pending evolution
  ipcMain.handle('skills:apply-evolution', async (_event, data: { skillId: string }) => {
    return skillEvolutionManager.applyEvolution(data.skillId)
  })

  // Skills Evolution: reject pending evolution
  ipcMain.handle('skills:reject-evolution', async (_event, data: { skillId: string }) => {
    return skillEvolutionManager.rejectEvolution(data.skillId)
  })

  // Skills Evolution: rollback to previous version
  ipcMain.handle('skills:rollback', async (_event, data: { skillId: string; version: string }) => {
    return skillEvolutionManager.rollback(data.skillId, data.version)
  })

  // Skills Evolution: delete a learning entry
  ipcMain.handle('skills:delete-record', async (_event, data: { skillId: string; recordId: string }) => {
    return skillManager.deleteRecord(data.skillId, data.recordId)
  })

  // File system: list directory
  ipcMain.handle('fs:list-directory', async (_event, dirPath: string) => {
    try {
      const items = fs.readdirSync(dirPath, { withFileTypes: true })
      return items
        .filter(item => !item.name.startsWith('.'))
        .map(item => ({
          name: item.name,
          path: path.join(dirPath, item.name),
          type: item.isDirectory() ? 'directory' : 'file',
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    } catch {
      return []
    }
  })

  // Open external links
  ipcMain.on('shell:open-external', (_event, url: string) => {
    shell.openExternal(url)
  })

  // Local model: status
  ipcMain.handle('local-model:status', async (_event, data?: { modelId?: string }) => {
    return localModelManager.checkModelStatus(data?.modelId)
  })

  // Local model: download
  ipcMain.handle('local-model:download', async (_event, data: { modelId: string }) => {
    try {
      await localModelManager.downloadModel(data.modelId, (progress, speed) => {
        mainWindow?.webContents.send('local-model:download-progress', {
          modelId: data.modelId,
          progress,
          speed,
        })
      })
      mainWindow?.webContents.send('local-model:status-change', {
        modelId: data.modelId,
        status: 'downloaded',
      })
      return { success: true }
    } catch (err: any) {
      mainWindow?.webContents.send('local-model:status-change', {
        modelId: data.modelId,
        status: 'error',
        error: err.message,
      })
      return { success: false, error: err.message }
    }
  })

  // Local model: cancel download
  ipcMain.handle('local-model:cancel-download', async () => {
    localModelManager.cancelDownload()
    return { success: true }
  })

  // Local model: delete
  ipcMain.handle('local-model:delete', async (_event, data: { modelId: string }) => {
    await localModelManager.deleteModel(data.modelId)
    return { success: true }
  })

  // Local model: load
  ipcMain.handle('local-model:load', async (_event, data: { modelId: string }) => {
    try {
      mainWindow?.webContents.send('local-model:status-change', {
        modelId: data.modelId,
        status: 'loading',
      })
      await localModelManager.loadModel(data.modelId)
      mainWindow?.webContents.send('local-model:status-change', {
        modelId: data.modelId,
        status: 'ready',
      })
      return { success: true }
    } catch (err: any) {
      mainWindow?.webContents.send('local-model:status-change', {
        modelId: data.modelId,
        status: 'error',
        error: err.message,
      })
      return { success: false, error: err.message }
    }
  })

  // Local model: unload
  ipcMain.handle('local-model:unload', async () => {
    await localModelManager.unloadModel()
    return { success: true }
  })

  // Get app data path
  ipcMain.handle('app:get-data-path', () => DATA_DIR)
}

app.whenReady().then(() => {
  ensureDirectories()
  localModelManager = new LocalModelManager(MODELS_DIR)
  skillManager = new SkillManager(getPrebuiltSkillsDir(), USER_SKILLS_DIR, IMPORTED_SKILLS_DIR)
  skillEvolutionManager = new SkillEvolutionManager(skillManager)

  agentManager = new AgentManager((channel, data) => {
    mainWindow?.webContents.send(channel, data)
  }, {
    artifactsDir: ARTIFACTS_DIR,
    localModelManager,
    onRunComplete: (params) => {
      // Fire-and-forget: record usage counts and save evolution records
      const { sessionId, currentRunSkillNames, sessionSkillNames, messages, apiConfig } = params

      // Record usage counts (only for skills @-mentioned in this run)
      for (const skillName of currentRunSkillNames) {
        skillManager.recordSkillUsage(skillName)
      }

      // Record usage for evolution (all session skills within recording window)
      // Saves formatted conversation log to EVOLUTION.json.
      // May trigger LLM compression of old records if storage exceeds budget.
      for (const skillName of sessionSkillNames) {
        skillEvolutionManager.recordUsage(skillName, sessionId, messages, apiConfig)
          .catch((err) => {
            console.error(`[SkillEvolution] Record usage error for ${skillName}:`, err)
          })
      }
    },
  })
  schedulerManager = new SchedulerManager(SCHEDULED_DIR, agentManager)

  createWindow()
  setupIPC()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  schedulerManager?.shutdown()
  agentManager?.stopAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
