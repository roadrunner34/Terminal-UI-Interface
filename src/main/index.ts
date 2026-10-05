import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { basename, join } from 'node:path'
import type { AgentConfig, AgentEvent, AgentId, ImageAttachment, PromptAnswer, SendOptions, StartOptions } from '@shared/events'
import type { AppSettings, SessionSummary, TabEvent } from '@shared/api'
import { createAdapter, staticOptions } from './agents/registry'
import { listProjectFiles } from './files'
import { listSessions, loadSession } from './history'
import type { AgentAdapter } from './agents/types'
import { Notifier } from './notify'
import { loadSettings, saveSettings } from './settings'

let win: BrowserWindow | null = null

/** One running agent per tab. The renderer names tabs; main only routes. */
interface TabSession {
  adapter: AgentAdapter
  agent: AgentId
  /** The session's folder; @-mentions list files from here only. */
  cwd: string
  notifier: Notifier
}
const tabs = new Map<string, TabSession>()

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
      // The preload only uses contextBridge and ipcRenderer, which work sandboxed.
      sandbox: true
    }
  })

  // Open links from rendered markdown in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // The window only ever shows the app; anything else opens in the browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win?.webContents.getURL()) return
    e.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
  // A reload drops the renderer's tabs; don't leave their agents running unseen.
  win.webContents.on('did-start-loading', stopAll)

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

// Streaming produces many tiny events; deliver them in one IPC message per
// frame rather than one each. Order is kept, so the renderer sees no difference.
let queue: TabEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
function emitFor(tab: string) {
  return (event: AgentEvent) => {
    queue.push({ tab, event })
    flushTimer ??= setTimeout(flush, 16)
    notify(tab, event)
  }
}
function flush() {
  flushTimer = null
  const batch = queue
  queue = []
  if (batch.length) win?.webContents.send('agent:events', batch)
}

let notifications = loadSettings().notifications

/** Desktop notifications, only while the window is in the background. */
function notify(tab: string, e: AgentEvent) {
  const n = tabs.get(tab)?.notifier.handle(e)
  if (!n || !notifications || !win || win.isFocused() || !Notification.isSupported()) return
  const note = new Notification({ title: n.title, body: n.body, silent: !n.urgent })
  note.on('click', () => {
    win?.show()
    win?.focus()
    // Bring up the tab the notification is about.
    win?.webContents.send('app:focusTab', tab)
  })
  note.show()
  if (n.urgent) win.flashFrame(true)
}

function stop(tab: string) {
  tabs.get(tab)?.adapter.dispose()
  tabs.delete(tab)
}

function stopAll() {
  for (const tab of [...tabs.keys()]) stop(tab)
}

/** Calls for a tab with no running agent are dropped (it was stopped or closed). */
function withTab(tab: string, fn: (s: TabSession) => void) {
  const s = tabs.get(tab)
  if (s) fn(s)
}

function registerIpc() {
  ipcMain.handle('agent:start', (_e, tab: string, opts: StartOptions) => {
    stop(tab)
    const config: AgentConfig = { model: opts.model ?? '', effort: opts.effort ?? '', mode: opts.mode ?? 'auto' }
    const settings = saveSettings({
      defaultAgent: opts.agent,
      lastCwd: opts.cwd,
      agentConfig: { ...loadSettings().agentConfig, [opts.agent]: config }
    })
    const emit = emitFor(tab)
    const session: TabSession = {
      adapter: createAdapter(opts.agent, emit, settings),
      agent: opts.agent,
      cwd: opts.cwd,
      notifier: new Notifier(() => opts.agent)
    }
    tabs.set(tab, session)
    session.adapter.start(opts)
    // Claude only emits its init record after the first prompt, so mark the
    // session live now; the agent's own session event fills in details later.
    emit({ kind: 'session', agent: opts.agent, sessionId: '', model: opts.model ?? '' })
  })
  ipcMain.handle('agent:send', (_e, tab: string, text: string, images?: ImageAttachment[], opts?: SendOptions) => {
    if (tabs.has(tab)) withTab(tab, (s) => s.adapter.send(text, images, opts))
    else emitFor(tab)({ kind: 'error', message: 'No session. Click Start first.' })
  })
  ipcMain.handle('files:list', (_e, tab: string) => {
    const s = tabs.get(tab)
    return s ? listProjectFiles(s.cwd) : []
  })
  ipcMain.handle('agent:abort', (_e, tab: string) => withTab(tab, (s) => s.adapter.abort()))
  ipcMain.handle('agent:compact', (_e, tab: string) => withTab(tab, (s) => s.adapter.compact()))
  ipcMain.handle('agent:clearQueue', (_e, tab: string) => withTab(tab, (s) => s.adapter.clearQueue()))
  ipcMain.handle('agent:contextUsage', (_e, tab: string) => withTab(tab, (s) => s.adapter.contextUsage()))
  ipcMain.handle('agent:stopTask', (_e, tab: string, taskId: string) => withTab(tab, (s) => s.adapter.stopTask(taskId)))
  ipcMain.handle('agent:shell', (_e, tab: string, command: string) => withTab(tab, (s) => s.adapter.shell(command)))
  ipcMain.handle('agent:rename', (_e, tab: string, title: string) => withTab(tab, (s) => s.adapter.rename(title)))
  ipcMain.handle('agent:fork', (_e, tab: string, entryId: string) => withTab(tab, (s) => s.adapter.fork(entryId)))
  ipcMain.handle('agent:rewind', (_e, tab: string, entryId: string) => withTab(tab, (s) => s.adapter.rewind(entryId)))
  // Main asks where to save, so the renderer never names a path to write.
  ipcMain.handle('agent:export', async (_e, tab: string) => {
    const s = tabs.get(tab)
    if (!s || !win) return false
    const pi = s.agent === 'pi'
    const res = await dialog.showSaveDialog(win, {
      title: 'Export session',
      defaultPath: join(s.cwd, `${basename(s.cwd) || 'session'}-${new Date().toISOString().slice(0, 10)}.${pi ? 'html' : 'jsonl'}`),
      filters: pi ? [{ name: 'Web page', extensions: ['html'] }] : [{ name: 'Claude transcript', extensions: ['jsonl'] }]
    })
    if (res.canceled || !res.filePath) return false
    tabs.get(tab)?.adapter.exportSession(res.filePath)
    return true
  })
  const remember = (agent: AgentId, change: Partial<AgentConfig>) => {
    const all = loadSettings().agentConfig
    saveSettings({ agentConfig: { ...all, [agent]: { ...all[agent], ...change } } })
  }
  ipcMain.handle('agent:configure', (_e, tab: string, change: Partial<AgentConfig>) =>
    withTab(tab, (s) => {
      s.adapter.configure(change)
      remember(s.agent, change)
    })
  )
  ipcMain.handle('agent:approvePlan', (_e, tab: string) =>
    withTab(tab, (s) => {
      s.adapter.approvePlan()
      remember(s.agent, { mode: 'auto' })
    })
  )
  ipcMain.handle('agent:answerPrompt', (_e, tab: string, id: string, answer: PromptAnswer) =>
    withTab(tab, (s) => s.adapter.answerPrompt(id, answer))
  )
  ipcMain.handle('agent:options', (_e, agent: AgentId) => staticOptions(agent))
  ipcMain.handle('agent:stop', (_e, tab: string) => {
    const had = tabs.has(tab)
    stop(tab)
    if (had) emitFor(tab)({ kind: 'exit', code: 0 })
  })
  ipcMain.handle('dialog:pickDirectory', async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    const next = saveSettings(patch)
    notifications = next.notifications
    return next
  })
  ipcMain.handle('history:list', (_e, cwd: string) => listSessions(cwd))
  // Only open files the list handed out, so the renderer can't read arbitrary paths.
  ipcMain.handle('history:load', async (_e, s: SessionSummary) => {
    const known = (await listSessions(s.cwd)).find((k) => k.agent === s.agent && k.path === s.path)
    if (!known) throw new Error('That session is no longer available.')
    return loadSession(known, loadSettings().piSubagentTools)
  })
}

app.whenReady().then(() => {
  // Windows only shows notifications for apps with an identity.
  if (process.platform === 'win32') app.setAppUserModelId('com.agentdeck.app')
  registerIpc()
  createWindow()
  win?.on('focus', () => win?.flashFrame(false))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopAll()
  if (process.platform !== 'darwin') app.quit()
})
