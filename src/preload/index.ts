import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentDeckApi, PiOutput, TabEvent } from '@shared/api'

const api: AgentDeckApi = {
  start: (tab, opts) => ipcRenderer.invoke('agent:start', tab, opts),
  send: (tab, text, images, opts) => ipcRenderer.invoke('agent:send', tab, text, images, opts),
  abort: (tab) => ipcRenderer.invoke('agent:abort', tab),
  compact: (tab) => ipcRenderer.invoke('agent:compact', tab),
  clearQueue: (tab) => ipcRenderer.invoke('agent:clearQueue', tab),
  contextUsage: (tab) => ipcRenderer.invoke('agent:contextUsage', tab),
  stopTask: (tab, taskId) => ipcRenderer.invoke('agent:stopTask', tab, taskId),
  mcp: (tab, action, name) => ipcRenderer.invoke('agent:mcp', tab, action, name),
  shell: (tab, command) => ipcRenderer.invoke('agent:shell', tab, command),
  rename: (tab, title) => ipcRenderer.invoke('agent:rename', tab, title),
  exportSession: (tab) => ipcRenderer.invoke('agent:export', tab),
  fork: (tab, entryId) => ipcRenderer.invoke('agent:fork', tab, entryId),
  rewind: (tab, entryId) => ipcRenderer.invoke('agent:rewind', tab, entryId),
  stop: (tab) => ipcRenderer.invoke('agent:stop', tab),
  configure: (tab, config) => ipcRenderer.invoke('agent:configure', tab, config),
  approvePlan: (tab) => ipcRenderer.invoke('agent:approvePlan', tab),
  answerPrompt: (tab, id, answer) => ipcRenderer.invoke('agent:answerPrompt', tab, id, answer),
  getOptions: (agent) => ipcRenderer.invoke('agent:options', agent),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  pickFile: (kind) => ipcRenderer.invoke('dialog:pickFile', kind),
  readContext: (cwd, which) => ipcRenderer.invoke('files:readContext', cwd, which),
  writeContext: (cwd, which, text) => ipcRenderer.invoke('files:writeContext', cwd, which, text),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  listSessions: (cwd) => ipcRenderer.invoke('history:list', cwd),
  loadSession: (s) => ipcRenderer.invoke('history:load', s),
  listFiles: (tab) => ipcRenderer.invoke('files:list', tab),
  listPiPackages: (cwd) => ipcRenderer.invoke('pi:listPackages', cwd),
  runPiPackage: (op, cwd) => ipcRenderer.invoke('pi:runPackage', op, cwd),
  onPiOutput: (cb) => {
    const listener = (_: IpcRendererEvent, o: PiOutput) => cb(o)
    ipcRenderer.on('pi:output', listener)
    return () => ipcRenderer.removeListener('pi:output', listener)
  },
  searchPiPackages: (query) => ipcRenderer.invoke('pi:searchPackages', query),
  reloadPiTabs: () => ipcRenderer.invoke('pi:reloadTabs'),
  onEvent: (cb) => {
    // Main batches events per frame (see emitFor in src/main/index.ts).
    const listener = (_: IpcRendererEvent, batch: TabEvent[]) => {
      for (const { tab, event } of batch) cb(tab, event)
    }
    ipcRenderer.on('agent:events', listener)
    return () => ipcRenderer.removeListener('agent:events', listener)
  },
  onFocusTab: (cb) => {
    const listener = (_: IpcRendererEvent, tab: string) => cb(tab)
    ipcRenderer.on('app:focusTab', listener)
    return () => ipcRenderer.removeListener('app:focusTab', listener)
  }
}

contextBridge.exposeInMainWorld('agentDeck', api)
