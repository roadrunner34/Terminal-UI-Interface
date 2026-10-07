import { app } from 'electron'
import { copyFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '@shared/api'
import { defaultConfig, type AgentId } from '@shared/events'

const defaults: AppSettings = {
  defaultAgent: 'claude',
  claudePath: 'claude',
  piPath: 'pi',
  permissionMode: 'acceptEdits',
  approvals: 'ask',
  notifications: true,
  piSubagentTools: ['subagent'],
  piAutoCompaction: true,
  lastCwd: '',
  agentConfig: {
    claude: defaultConfig(),
    pi: defaultConfig()
  },
  sessionOptions: { claude: {}, pi: {} }
}

const file = () => join(app.getPath('userData'), 'settings.json')

/** Files already set aside this run, so repeated loads don't copy them again. */
const setAside = new Set<string>()

export function loadSettings(): AppSettings {
  const path = file()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // No file yet: first run.
    return withDefaults({})
  }
  try {
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not an object')
    return withDefaults(saved)
  } catch {
    // Keep the unreadable file, so the next save doesn't silently replace it with defaults.
    if (!setAside.has(path)) {
      setAside.add(path)
      try {
        copyFileSync(path, `${path}.bad`)
        console.warn(`[settings] ${path} could not be read; kept a copy as settings.json.bad and used defaults.`)
      } catch {
        // Nothing more to keep.
      }
    }
    return withDefaults({})
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const path = file()
  const next = { ...loadSettings(), ...patch }
  const text = JSON.stringify(next, null, 2)
  // Written beside the file and renamed over it, so a crash mid-write can't leave it torn.
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  } catch {
    // Windows can refuse the rename while something (e.g. a virus scanner) has the file open.
    rmSync(tmp, { force: true })
    writeFileSync(path, text)
  }
  return next
}

/** Merge per agent, so files saved before a field existed still get its default. */
function withDefaults(saved: any): AppSettings {
  const agentConfig = { ...defaults.agentConfig }
  for (const id of Object.keys(agentConfig) as AgentId[]) agentConfig[id] = { ...defaultConfig(), ...saved.agentConfig?.[id] }
  const sessionOptions = { claude: { ...saved.sessionOptions?.claude }, pi: { ...saved.sessionOptions?.pi } }
  return { ...defaults, ...saved, agentConfig, sessionOptions }
}
