import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentDeckApi, TabEvent } from '@shared/api'

const api: AgentDeckApi = {
  start: (tab, opts) => ipcRenderer.invoke('agent:start', tab, opts),
  send: (tab, text, images, opts) => ipcRenderer.invoke('agent:send', tab, text, images, opts),
  abort: (tab) => ipcRenderer.invoke('agent:abort', tab),
  compact: (tab) => ipcRenderer.invoke('agent:compact', tab),
  clearQueue: (tab) => ipcRenderer.invoke('agent:clearQueue', tab),
  stop: (tab) => ipcRenderer.invoke('agent:stop', tab),
  configure: (tab, config) => ipcRenderer.invoke('agent:configure', tab, config),
  approvePlan: (tab) => ipcRenderer.invoke('agent:approvePlan', tab),
  answerPrompt: (tab, id, answer) => ipcRenderer.invoke('agent:answerPrompt', tab, id, answer),
  getOptions: (agent) => ipcRenderer.invoke('agent:options', agent),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  listSessions: (cwd) => ipcRenderer.invoke('history:list', cwd),
  loadSession: (s) => ipcRenderer.invoke('history:load', s),
  listFiles: (tab) => ipcRenderer.invoke('files:list', tab),
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
