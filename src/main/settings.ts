import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '@shared/api'

const defaults: AppSettings = {
  defaultAgent: 'claude',
  claudePath: 'claude',
  piPath: 'pi',
  permissionMode: 'acceptEdits',
  piSubagentTools: ['subagent'],
  lastCwd: '',
  agentConfig: {
    claude: { model: '', effort: '' },
    pi: { model: '', effort: '' }
  }
}

const file = () => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): AppSettings {
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8'))
    return { ...defaults, ...saved, agentConfig: { ...defaults.agentConfig, ...saved.agentConfig } }
  } catch {
    return { ...defaults }
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch }
  writeFileSync(file(), JSON.stringify(next, null, 2))
  return next
}
