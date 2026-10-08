// Settings persistence: saves replace the file in one step, and a file that
// won't parse is kept aside rather than overwritten with defaults.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const paths = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => paths.dir } }))

import { cleanSettingsPatch, loadSettings, saveSettings } from '../src/main/settings'

const file = () => join(paths.dir, 'settings.json')

describe('Settings file', () => {
  beforeEach(() => {
    paths.dir = mkdtempSync(join(tmpdir(), 'agent-deck-settings-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    rmSync(paths.dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('starts from defaults and keeps what is saved', () => {
    expect(loadSettings().claudePath).toBe('claude')
    saveSettings({ claudePath: 'C:/tools/claude.exe', lastCwd: 'D:/proj' })
    expect(loadSettings()).toMatchObject({ claudePath: 'C:/tools/claude.exe', lastCwd: 'D:/proj', piPath: 'pi' })
  })

  it('replaces the file in one step, leaving no temp file behind', () => {
    saveSettings({ lastCwd: 'a' })
    saveSettings({ lastCwd: 'b' })
    expect(readdirSync(paths.dir)).toEqual(['settings.json'])
    expect(JSON.parse(readFileSync(file(), 'utf8')).lastCwd).toBe('b')
  })

  it('keeps a torn file aside instead of losing it to the next save', () => {
    const torn = '{"claudePath": "C:/tools/cla'
    writeFileSync(file(), torn)
    expect(loadSettings().claudePath).toBe('claude')
    expect(readFileSync(`${file()}.bad`, 'utf8')).toBe(torn)
    saveSettings({ lastCwd: 'x' })
    expect(readFileSync(`${file()}.bad`, 'utf8')).toBe(torn)
    expect(loadSettings().lastCwd).toBe('x')
  })

  it('treats JSON that is not an object as unreadable', () => {
    writeFileSync(file(), 'null')
    expect(loadSettings().piPath).toBe('pi')
    expect(readFileSync(`${file()}.bad`, 'utf8')).toBe('null')
  })

  it('fills in fields a file from an older version lacks', () => {
    writeFileSync(file(), JSON.stringify({ agentConfig: { claude: { model: 'opus' } } }))
    const s = loadSettings()
    expect(s.agentConfig).toEqual({ claude: { model: 'opus', effort: '', mode: 'auto' }, pi: { model: '', effort: '', mode: 'auto' } })
    expect(s.sessionOptions).toEqual({ claude: {}, pi: {} })
  })
})

describe('Settings the renderer may save', () => {
  it('keeps the fields the Settings dialog edits', () => {
    const patch = {
      claudePath: '  C:\\Program Files\\claude\\claude.exe ',
      piPath: 'pi',
      permissionMode: 'bypassPermissions',
      approvals: 'deny',
      notifications: false,
      piAutoCompaction: true,
      piSubagentTools: ['subagent', 'delegate']
    }
    expect(cleanSettingsPatch(patch)).toEqual({ ...patch, claudePath: 'C:\\Program Files\\claude\\claude.exe' })
  })

  it('drops what main records itself, and malformed values', () => {
    expect(
      cleanSettingsPatch({
        lastCwd: 'C:\\Windows',
        agentConfig: { claude: { model: 'opus' } },
        sessionOptions: { claude: { bare: true } },
        defaultAgent: 'pi',
        claudePath: '   ',
        permissionMode: 'plan --x',
        approvals: 'always',
        notifications: 'yes',
        piSubagentTools: ['subagent', 'rm -rf', 42]
      })
    ).toEqual({ piSubagentTools: ['subagent'] })
    expect(cleanSettingsPatch(null)).toEqual({})
  })
})
