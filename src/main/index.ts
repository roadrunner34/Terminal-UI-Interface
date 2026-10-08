import { app, BrowserWindow, dialog, ipcMain, net, Notification, session as webSession, shell, type IpcMainInvokeEvent } from 'electron'
import { basename, join } from 'node:path'
import type { AgentConfig, AgentEvent, AgentId, ImageAttachment, McpAction, PromptAnswer, SendOptions } from '@shared/events'
import type { PiContextFile, PiOutput, PiPackageOp, SessionSummary, TabEvent } from '@shared/api'
import { PiAdapter } from './agents/pi'
import { isContextFile, readContextFile, writeContextFile } from './context-files'
import { listPiPackages, piPackageArgs, plainLine, searchPiPackages } from './pi-packages'
import { run, type Run } from './runner'
import { cleanConfigChange, cleanStartOptions, removeTempFiles, sweepTempFiles } from './agents/options'
import { createAdapter, staticOptions } from './agents/registry'
import { listProjectFiles } from './files'
import { listSessions, loadSession } from './history'
import type { AgentAdapter } from './agents/types'
import { Notifier } from './notify'
import { cleanSettingsPatch, loadSettings, saveSettings } from './settings'
import { probeVersion } from './versions'

let win: BrowserWindow | null = null
/** The app is quitting (not just closing its window), so a confirmed close should finish the quit. */
let quitting = false

const MCP_ACTIONS = new Set<McpAction>(['status', 'reconnect', 'enable', 'disable', 'auth', 'logout'])

/** One running agent per tab. The renderer names tabs; main only routes. */
interface TabSession {
  adapter: AgentAdapter
  agent: AgentId
  /** The session's folder; @-mentions list files from here only. */
  cwd: string
  notifier: Notifier
  /** Mid-turn, followed from its events the way the renderer's reducer does. */
  busy: boolean
}
const tabs = new Map<string, TabSession>()

/** To the window, if it is still there (it may close while agents are winding down). */
function send(channel: string, ...args: unknown[]) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function createWindow() {
  const w = new BrowserWindow({
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
  win = w

  // Open links from rendered markdown in the system browser, never in-app.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // The window only ever shows the app; anything else opens in the browser.
  w.webContents.on('will-navigate', (e, url) => {
    if (url === w.webContents.getURL()) return
    e.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
  // A reload drops the renderer's tabs; don't leave their agents running unseen.
  w.webContents.on('did-start-loading', stopAll)

  // Closing ends every session, so ask first when an agent is mid-turn, as closing a tab does.
  let confirmed = false
  w.on('close', (e) => {
    const working = [...tabs.values()].filter((t) => t.busy).length
    if (!working || confirmed) return
    e.preventDefault()
    void dialog
      .showMessageBox(w, {
        type: 'warning',
        title: 'Agent Deck',
        message: working === 1 ? 'An agent is still working.' : `${working} agents are still working.`,
        detail: 'Closing the window ends their sessions.',
        buttons: ['Close anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1
      })
      .then(({ response }) => {
        if (response !== 0) {
          quitting = false
          return
        }
        confirmed = true
        if (quitting) app.quit()
        else w.close()
      })
  })
  w.on('closed', () => {
    if (win === w) win = null
  })
  w.on('focus', () => w.flashFrame(false))

  if (process.env.ELECTRON_RENDERER_URL) w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else w.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Brings the window back, e.g. when the app is launched a second time. */
function focusWindow() {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// Streaming produces many tiny events; deliver them in one IPC message per
// frame rather than one each. Order is kept, so the renderer sees no difference.
let queue: TabEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
function emitFor(tab: string) {
  return (event: AgentEvent) => {
    const t = tabs.get(tab)
    if (t) trackBusy(t, event)
    queue.push({ tab, event })
    flushTimer ??= setTimeout(flush, 16)
    notify(tab, event)
  }
}
function flush() {
  flushTimer = null
  const batch = queue
  queue = []
  if (batch.length) send('agent:events', batch)
}

function trackBusy(t: TabSession, e: AgentEvent) {
  if (e.kind === 'turn-start' || (e.kind === 'user-message' && (!e.scope || e.scope === 'main'))) t.busy = true
  else if (e.kind === 'turn-end' || e.kind === 'exit') t.busy = false
}

let notifications = loadSettings().notifications

/** Desktop notifications, only while the window is in the background. */
function notify(tab: string, e: AgentEvent) {
  const n = tabs.get(tab)?.notifier.handle(e)
  if (!n || !notifications || !win || win.isDestroyed() || win.isFocused() || !Notification.isSupported()) return
  const note = new Notification({ title: n.title, body: n.body, silent: !n.urgent })
  note.on('click', () => {
    focusWindow()
    // Bring up the tab the notification is about.
    send('app:focusTab', tab)
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

/** The package command in progress, if any (one at a time). */
let packageRun: Run | null = null

/**
 * Folders the renderer may name: the last one used when the app started, the
 * ones picked this run, and so every one a tab has run in. Main keeps the
 * list itself; nothing the renderer saves or sends can add to it.
 */
const known = new Set<string>()

/** Sessions run in, and instruction files are read or written for, known folders only. */
function knownFolder(cwd: unknown): cwd is string {
  return typeof cwd === 'string' && known.has(cwd)
}

/** Calls for a tab with no running agent are dropped (it was stopped or closed). */
function withTab(tab: string, fn: (s: TabSession) => void) {
  const s = tabs.get(tab)
  if (s) fn(s)
}

/** Each version warning shows once per run in the transcript (Settings always shows it). */
const versionWarned = new Set<string>()

/** Only the app's own page may call main: not a frame inside it, another window, or a page it navigated to. */
function fromApp(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame
  if (!win || win.isDestroyed() || e.sender !== win.webContents || !frame || frame.parent) return false
  const dev = process.env.ELECTRON_RENDERER_URL
  return dev ? frame.url.startsWith(dev) : frame.url.startsWith('file:')
}

function handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) throw new Error(`Refused ${channel}: it didn't come from the app's window.`)
    return fn(e, ...args)
  })
}

function registerIpc() {
  handle('agent:start', async (_e, tab: string, raw: unknown) => {
    const fail = (message: string) => emitFor(tab)({ kind: 'error', message })
    const opts = cleanStartOptions(raw)
    if ('error' in opts) return fail(opts.error)
    if (!knownFolder(opts.cwd)) return fail('Choose the project folder with the folder button first.')
    // A saved session continues only if the history lists it for this folder.
    const resume = opts.resume
    if (resume && !(await listSessions(opts.cwd)).some((s) => s.agent === opts.agent && s.path === resume.path))
      return fail('That saved session is no longer available.')
    stop(tab)
    const config: AgentConfig = { model: opts.model ?? '', effort: opts.effort ?? '', mode: opts.mode ?? 'auto' }
    const saved = loadSettings()
    const settings = saveSettings({
      defaultAgent: opts.agent,
      lastCwd: opts.cwd,
      agentConfig: { ...saved.agentConfig, [opts.agent]: config },
      // A resumed session reuses the form's options too; remember what was used.
      sessionOptions: { ...saved.sessionOptions, [opts.agent]: opts.advanced ?? {} }
    })
    const emit = emitFor(tab)
    const session: TabSession = {
      // Adapters only hand over https URLs (MCP sign-in pages).
      adapter: createAdapter(opts.agent, emit, { ...settings, openUrl: (url) => void shell.openExternal(url) }),
      agent: opts.agent,
      cwd: opts.cwd,
      notifier: new Notifier(() => opts.agent),
      busy: false
    }
    tabs.set(tab, session)
    session.adapter.start(opts)
    // Claude only emits its init record after the first prompt, so mark the
    // session live now; the agent's own session event fills in details later.
    emit({ kind: 'session', agent: opts.agent, sessionId: '', model: opts.model ?? '' })
    // A CLI outside the tested range is the first suspect when something
    // fails, so say so up front.
    const command = opts.agent === 'claude' ? settings.claudePath : settings.piPath
    void probeVersion(opts.agent, command).then((v) => {
      const key = `${v.agent}\0${v.version}`
      if ((v.status !== 'old' && v.status !== 'new') || !v.message || versionWarned.has(key) || tabs.get(tab) !== session) return
      versionWarned.add(key)
      emit({ kind: 'notice', text: v.message })
    })
  })
  handle('agent:send', (_e, tab: string, text: string, images?: ImageAttachment[], opts?: SendOptions) => {
    if (tabs.has(tab)) withTab(tab, (s) => s.adapter.send(text, images, opts))
    else emitFor(tab)({ kind: 'error', message: 'No session. Click Start first.' })
  })
  handle('files:list', (_e, tab: string) => {
    const s = tabs.get(tab)
    return s ? listProjectFiles(s.cwd) : []
  })
  handle('agent:abort', (_e, tab: string) => withTab(tab, (s) => s.adapter.abort()))
  handle('agent:compact', (_e, tab: string) => withTab(tab, (s) => s.adapter.compact()))
  handle('agent:clearQueue', (_e, tab: string) => withTab(tab, (s) => s.adapter.clearQueue()))
  handle('agent:contextUsage', (_e, tab: string) => withTab(tab, (s) => s.adapter.contextUsage()))
  handle('agent:stopTask', (_e, tab: string, taskId: string) => withTab(tab, (s) => s.adapter.stopTask(taskId)))
  handle('agent:mcp', (_e, tab: string, action: McpAction, name?: string) => {
    if (!MCP_ACTIONS.has(action)) return
    withTab(tab, (s) => s.adapter.mcp(action, typeof name === 'string' ? name : undefined))
  })
  handle('agent:shell', (_e, tab: string, command: string) => withTab(tab, (s) => s.adapter.shell(command)))
  handle('agent:rename', (_e, tab: string, title: string) => withTab(tab, (s) => s.adapter.rename(title)))
  handle('agent:fork', (_e, tab: string, entryId: string) => withTab(tab, (s) => s.adapter.fork(entryId)))
  handle('agent:rewind', (_e, tab: string, entryId: string) => withTab(tab, (s) => s.adapter.rewind(entryId)))
  // Main asks where to save, so the renderer never names a path to write.
  handle('agent:export', async (_e, tab: string) => {
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
  handle('agent:configure', (_e, tab: string, raw: unknown) =>
    withTab(tab, (s) => {
      const change = cleanConfigChange(raw)
      if (!Object.keys(change).length) return
      s.adapter.configure(change)
      remember(s.agent, change)
    })
  )
  handle('agent:approvePlan', (_e, tab: string) =>
    withTab(tab, (s) => {
      s.adapter.approvePlan()
      remember(s.agent, { mode: 'auto' })
    })
  )
  handle('agent:answerPrompt', (_e, tab: string, id: string, answer: PromptAnswer) =>
    withTab(tab, (s) => s.adapter.answerPrompt(id, answer))
  )
  handle('agent:options', (_e, agent: AgentId) => staticOptions(agent))
  handle('agent:stop', (_e, tab: string) => {
    const had = tabs.has(tab)
    stop(tab)
    if (had) emitFor(tab)({ kind: 'exit', code: 0 })
  })
  handle('dialog:pickDirectory', async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (res.canceled) return null
    known.add(res.filePaths[0])
    return res.filePaths[0]
  })
  handle('dialog:pickFile', async (_e, kind: 'json') => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: kind === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : []
    })
    return res.canceled ? null : res.filePaths[0]
  })
  handle('files:readContext', (_e, cwd: string, which: PiContextFile) => {
    if (!isContextFile(which) || !knownFolder(cwd)) throw new Error('That folder or file is not available.')
    return readContextFile(cwd, which)
  })
  handle('files:writeContext', (_e, cwd: string, which: PiContextFile, text: string) => {
    if (!isContextFile(which) || !knownFolder(cwd)) throw new Error('That folder or file is not available.')
    return writeContextFile(cwd, which, text)
  })
  // Pi packages. The renderer names an operation and a source, never argv.
  handle('pi:listPackages', (_e, cwd?: string) => listPiPackages(knownFolder(cwd) ? cwd : undefined))
  handle('pi:runPackage', (_e, op: PiPackageOp, cwd?: string) => {
    if (packageRun) return { error: 'Another package command is still running.' }
    if (!op || typeof op !== 'object') return { error: 'Unknown package operation.' }
    const built = piPackageArgs(op)
    if ('error' in built) return built
    if (op.local && !knownFolder(cwd)) return { error: 'Choose the project folder first.' }
    const id = `pkg-${Date.now()}`
    const output = (o: PiOutput) => send('pi:output', o)
    // Project commands run in the project; user ones anywhere outside one.
    const where = op.local && typeof cwd === 'string' ? cwd : app.getPath('home')
    const r = run(loadSettings().piPath, built.args, {
      cwd: where,
      timeoutMs: 10 * 60_000,
      onLine: (line) => output({ id, line: plainLine(line) })
    })
    packageRun = r
    output({ id, line: `$ pi ${built.args.join(' ')}` })
    r.done.then((res) => {
      packageRun = null
      if (res.timedOut) output({ id, line: 'Stopped after 10 minutes.' })
      output({ id, exit: res.code })
    })
    return { id }
  })
  handle('pi:searchPackages', (_e, query: unknown) =>
    searchPiPackages(typeof query === 'string' ? query : '', (url) => net.fetch(url))
  )
  handle('pi:reloadTabs', () => {
    let reloaded = 0
    let later = 0
    for (const t of tabs.values()) if (t.adapter instanceof PiAdapter) t.adapter.reload() ? reloaded++ : later++
    return { reloaded, later }
  })
  handle('settings:get', () => loadSettings())
  // Only what the Settings dialog edits; main records the rest itself.
  handle('settings:save', (_e, patch: unknown) => {
    const next = saveSettings(cleanSettingsPatch(patch))
    notifications = next.notifications
    return next
  })
  handle('app:versions', (_e, fresh?: unknown) => {
    const s = loadSettings()
    return Promise.all([probeVersion('claude', s.claudePath, fresh === true), probeVersion('pi', s.piPath, fresh === true)])
  })
  handle('history:list', (_e, cwd: string) => (knownFolder(cwd) ? listSessions(cwd) : []))
  // Only open files the list handed out, so the renderer can't read arbitrary paths.
  handle('history:load', async (_e, s: SessionSummary) => {
    const listed = knownFolder(s?.cwd) && (await listSessions(s.cwd)).find((k) => k.agent === s.agent && k.path === s.path)
    if (!listed) throw new Error('That session is no longer available.')
    return loadSession(listed, loadSettings().piSubagentTools)
  })
}

// One window and one settings file: a second launch brings this one forward instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', focusWindow)
  app.whenReady().then(() => {
    // Windows only shows notifications for apps with an identity.
    if (process.platform === 'win32') app.setAppUserModelId('com.agentdeck.app')
    // The page needs no browser permissions (camera, location, the page's own notifications, …).
    webSession.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    webSession.defaultSession.setPermissionCheckHandler(() => false)
    const last = loadSettings().lastCwd
    if (last) known.add(last)
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
    // Temp files a crashed run left behind.
    sweepTempFiles()
  })
}

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  stopAll()
  packageRun?.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', removeTempFiles)
