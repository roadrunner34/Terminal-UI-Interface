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
  piSubagentTools: ['subagent'],
  lastCwd: '',
  agentConfig: {
    claude: defaultConfig(),
    pi: defaultConfig()
  }
}

const file = () => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): AppSettings {
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8'))
    // Merge per agent, so files saved before a field existed still get its default.
    const agentConfig = { ...defaults.agentConfig }
    for (const id of Object.keys(agentConfig) as AgentId[])
      agentConfig[id] = { ...defaultConfig(), ...saved.agentConfig?.[id] }
    return { ...defaults, ...saved, agentConfig }
  } catch {
    return { ...defaults }
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch }
  writeFileSync(file(), JSON.stringify(next, null, 2))
  return next
}
