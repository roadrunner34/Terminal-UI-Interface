// Agent CLI versions against the ones Agent Deck was tested with
// (Claude Code 2.1.292 and Pi 1.0.4 at the time of writing).
import { describe, expect, it } from 'vitest'
import { checkVersion, compareVersions, parseVersion, probeVersion, TESTED_VERSIONS } from '../src/main/versions'

describe('CLI versions', () => {
  it('reads the version from each CLI’s --version line', () => {
    expect(parseVersion('2.1.292 (Claude Code)')).toBe('2.1.292')
    expect(parseVersion('1.0.4\n')).toBe('1.0.4')
    expect(parseVersion('v26.4.0')).toBe('26.4.0')
    expect(parseVersion('pi: command not found')).toBeNull()
  })

  it('compares versions by number, not text', () => {
    expect(compareVersions('2.1.292', '2.1.292')).toBe(0)
    expect(compareVersions('2.1.300', '2.1.292')).toBeGreaterThan(0)
    expect(compareVersions('2.1.29', '2.1.292')).toBeLessThan(0)
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0)
  })

  it('accepts the tested version and later ones of the same major', () => {
    expect(checkVersion('claude', 'claude', TESTED_VERSIONS.claude.min)).toMatchObject({ status: 'ok', version: '2.1.292' })
    expect(checkVersion('claude', 'claude', '2.4.0').status).toBe('ok')
    expect(checkVersion('pi', 'pi', '1.3.0').status).toBe('ok')
  })

  it('warns about older versions, with how to update', () => {
    const v = checkVersion('pi', 'pi', '1.0.1')
    expect(v.status).toBe('old')
    expect(v.message).toContain('Pi 1.0.1 is older than 1.0.4')
    expect(v.message).toContain('`pi update`')
  })

  it('warns about a newer major version', () => {
    const v = checkVersion('claude', 'claude', '3.0.0')
    expect(v.status).toBe('new')
    expect(v.message).toContain('(2.x)')
  })

  it('says when it can’t tell the version', () => {
    expect(checkVersion('claude', 'my-claude', null)).toMatchObject({ status: 'unknown', command: 'my-claude' })
  })

  it('runs the command to find out', async () => {
    // node stands in for a CLI: it answers --version with v<major>.x.y.
    const v = await probeVersion('pi', 'node', true)
    expect(v.version).toBe(process.versions.node)
    expect(v.status).toBe('new')
  })

  it('reports a command that can’t be run', async () => {
    const v = await probeVersion('claude', 'agent-deck-no-such-cli', true)
    expect(v).toMatchObject({ status: 'missing', command: 'agent-deck-no-such-cli' })
    expect(v.message).toContain('Check the command in Settings')
  })
})
