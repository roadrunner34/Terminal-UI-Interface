import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentDeckApi } from '@shared/api'
import type { AgentEvent } from '@shared/events'

const api: AgentDeckApi = {
  start: (opts) => ipcRenderer.invoke('agent:start', opts),
  send: (text) => ipcRenderer.invoke('agent:send', text),
  abort: () => ipcRenderer.invoke('agent:abort'),
  stop: () => ipcRenderer.invoke('agent:stop'),
  configure: (config) => ipcRenderer.invoke('agent:configure', config),
  getOptions: (agent) => ipcRenderer.invoke('agent:options', agent),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  onEvent: (cb) => {
    const listener = (_: IpcRendererEvent, e: AgentEvent) => cb(e)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  }
}

contextBridge.exposeInMainWorld('agentDeck', api)
