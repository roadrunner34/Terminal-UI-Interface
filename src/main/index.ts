import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { AgentConfig, AgentEvent, AgentId, StartOptions } from '@shared/events'
import type { AppSettings, SessionSummary } from '@shared/api'
import { createAdapter, staticOptions } from './agents/registry'
import { listSessions, loadSession } from './history'
import type { AgentAdapter } from './agents/types'
import { loadSettings, saveSettings } from './settings'

let win: BrowserWindow | null = null
let adapter: AgentAdapter | null = null
let currentAgent: AgentId | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Agent Deck',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Open links from rendered markdown in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

const emit = (e: AgentEvent) => win?.webContents.send('agent:event', e)

function registerIpc() {
  ipcMain.handle('agent:start', (_e, opts: StartOptions) => {
    adapter?.dispose()
    currentAgent = opts.agent
    const config: AgentConfig = { model: opts.model ?? '', effort: opts.effort ?? '', mode: opts.mode ?? 'auto' }
    const settings = saveSettings({
      defaultAgent: opts.agent,
      lastCwd: opts.cwd,
      agentConfig: { ...loadSettings().agentConfig, [opts.agent]: config }
    })
    adapter = createAdapter(opts.agent, emit, settings)
    adapter.start(opts)
    // Claude only emits its init record after the first prompt, so mark the
    // session live now; the agent's own session event fills in details later.
    emit({ kind: 'session', agent: opts.agent, sessionId: '', model: opts.model ?? '' })
  })
  ipcMain.handle('agent:send', (_e, text: string) => {
    if (!adapter) emit({ kind: 'error', message: 'No session. Click Start first.' })
    else adapter.send(text)
  })
  ipcMain.handle('agent:abort', () => adapter?.abort())
  ipcMain.handle('agent:configure', (_e, change: Partial<AgentConfig>) => {
    if (!adapter || !currentAgent) return
    adapter.configure(change)
    const all = loadSettings().agentConfig
    saveSettings({ agentConfig: { ...all, [currentAgent]: { ...all[currentAgent], ...change } } })
  })
  ipcMain.handle('agent:options', (_e, agent: AgentId) => staticOptions(agent))
  ipcMain.handle('agent:stop', () => {
    adapter?.dispose()
    adapter = null
    emit({ kind: 'exit', code: 0 })
  })
  ipcMain.handle('dialog:pickDirectory', async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => saveSettings(patch))
  ipcMain.handle('history:list', (_e, cwd: string) => listSessions(cwd))
  // Only open files the list handed out, so the renderer can't read arbitrary paths.
  ipcMain.handle('history:load', async (_e, s: SessionSummary) => {
    const known = (await listSessions(s.cwd)).find((k) => k.agent === s.agent && k.path === s.path)
    if (!known) throw new Error('That session is no longer available.')
    return loadSession(known, loadSettings().piSubagentTools)
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  adapter?.dispose()
  if (process.platform !== 'darwin') app.quit()
})
