import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { AgentManager } from './agent/index'
import { SchedulerManager } from './agent/scheduler'

let mainWindow: BrowserWindow | null = null
let agentManager: AgentManager
let schedulerManager: SchedulerManager

const DATA_DIR = path.join(app.getPath('userData'), 'onit-data')
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
const SCHEDULED_DIR = path.join(DATA_DIR, 'scheduled')

function ensureDirectories() {
  for (const dir of [DATA_DIR, SESSIONS_DIR, SCHEDULED_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#FAFAFA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  })

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

  // Agent: start
  ipcMain.handle('agent:start', async (_event, data: { sessionId: string; message: string; session: any }) => {
    return agentManager.startAgent(data.sessionId, data.message, data.session)
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
    return schedulerManager.runTaskNow(data.id)
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

  // Get app data path
  ipcMain.handle('app:get-data-path', () => DATA_DIR)
}

app.whenReady().then(() => {
  ensureDirectories()
  agentManager = new AgentManager((channel, data) => {
    mainWindow?.webContents.send(channel, data)
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
