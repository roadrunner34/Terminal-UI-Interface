import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
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

export function loadSettings(): AppSettings {
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8'))
    // Merge per agent, so files saved before a field existed still get its default.
    const agentConfig = { ...defaults.agentConfig }
    for (const id of Object.keys(agentConfig) as AgentId[])
      agentConfig[id] = { ...defaultConfig(), ...saved.agentConfig?.[id] }
    const sessionOptions = { claude: { ...saved.sessionOptions?.claude }, pi: { ...saved.sessionOptions?.pi } }
    return { ...defaults, ...saved, agentConfig, sessionOptions }
  } catch {
    return { ...defaults }
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch }
  writeFileSync(file(), JSON.stringify(next, null, 2))
  return next
}
