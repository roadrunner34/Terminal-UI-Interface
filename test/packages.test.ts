// Pi package browser: reading what's installed, the closed set of `pi`
// commands, npm search, and the runner that streams their output. Layout and
// commands follow a live run of pi 1.0.4 in a scratch PI_CODING_AGENT_DIR.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PiAdapter } from '../src/main/agents/pi'
import type { AdapterSettings } from '../src/main/agents/types'
import { listPiPackages, npmName, piPackageArgs, plainLine, searchPiPackages } from '../src/main/pi-packages'
import { run } from '../src/main/runner'
import type { AgentEvent } from '../src/shared/events'

let root: string
const write = (rel: string, data: unknown) => {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-deck-pkg-'))
  write('agent/settings.json', {
    packages: ['npm:pi-plan', 'npm:@acme/pi-tools@1.2.0', { source: 'git:github.com/u/skills', skills: ['review'] }, 'npm:gone']
  })
  write('agent/npm/node_modules/pi-plan/package.json', {
    name: 'pi-plan',
    version: '0.1.1',
    description: 'Plan mode for pi',
    pi: { extensions: ['./extensions/plan'] }
  })
  write('agent/npm/node_modules/@acme/pi-tools/package.json', {
    name: '@acme/pi-tools',
    version: '1.2.0',
    pi: { extensions: ['a', 'b'], skills: ['s'], prompts: [] }
  })
  write('my project/.pi/settings.json', { packages: ['npm:pi-plan'] })
  write('my project/.pi/npm/node_modules/pi-plan/package.json', { name: 'pi-plan', version: '0.2.0' })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('listPiPackages', () => {
  it('reads user packages with their manifests', async () => {
    const list = await listPiPackages(undefined, join(root, 'agent'))
    expect(list).toEqual([
      {
        source: 'npm:pi-plan',
        scope: 'user',
        kind: 'npm',
        filtered: false,
        installed: true,
        name: 'pi-plan',
        version: '0.1.1',
        description: 'Plan mode for pi',
        resources: { extensions: 1 }
      },
      {
        source: 'npm:@acme/pi-tools@1.2.0',
        scope: 'user',
        kind: 'npm',
        filtered: false,
        installed: true,
        name: '@acme/pi-tools',
        version: '1.2.0',
        resources: { extensions: 2, skills: 1 }
      },
      { source: 'git:github.com/u/skills', scope: 'user', kind: 'git', filtered: true, installed: false },
      { source: 'npm:gone', scope: 'user', kind: 'npm', filtered: false, installed: false, name: 'gone' }
    ])
  })

  it("adds the project's packages, installed under its own .pi/npm", async () => {
    const list = await listPiPackages(join(root, 'my project'), join(root, 'agent'))
    expect(list.filter((p) => p.scope === 'project')).toEqual([
      { source: 'npm:pi-plan', scope: 'project', kind: 'npm', filtered: false, installed: true, name: 'pi-plan', version: '0.2.0' }
    ])
  })

  it('is empty without settings', async () => {
    expect(await listPiPackages(join(root, 'nowhere'), join(root, 'no-agent'))).toEqual([])
  })
})

describe('piPackageArgs', () => {
  it.each([
    [{ op: 'install', source: 'npm:pi-foo' }, ['install', 'npm:pi-foo']],
    [{ op: 'install', source: 'npm:@s/pi-foo@1.0.0', local: true }, ['install', 'npm:@s/pi-foo@1.0.0', '-l']],
    [{ op: 'remove', source: 'git:github.com/u/r' }, ['remove', 'git:github.com/u/r']],
    [{ op: 'remove', source: 'npm:pi-foo', local: true }, ['remove', 'npm:pi-foo', '-l', '--approve']],
    [{ op: 'update', source: 'npm:pi-foo' }, ['update', 'npm:pi-foo']],
    [{ op: 'update', source: 'npm:pi-foo', local: true }, ['update', 'npm:pi-foo', '--approve']],
    [{ op: 'update-all' }, ['update', '--extensions']]
  ] as const)('%j → pi %j', (op, args) => {
    expect(piPackageArgs(op)).toEqual({ args })
  })

  it.each(['pi', 'self', '--self', '--all', 'npm:@earendil-works/pi-coding-agent', 'NPM:PI'])('never updates Pi itself (%s)', (source) => {
    expect(piPackageArgs({ op: 'update', source })).toHaveProperty('error')
  })

  it.each(['C:\\pkgs\\mine', './local', 'npm:foo bar', 'npm:foo;calc', '--global', 'file:///x', ''])('refuses %j', (source) => {
    expect(piPackageArgs({ op: 'install', source })).toHaveProperty('error')
  })

  it('knows npm names', () => {
    expect(npmName('npm:@a/b@^1.0')).toBe('@a/b')
    expect(npmName('npm:pi-foo')).toBe('pi-foo')
    expect(npmName('git:github.com/u/r')).toBeNull()
  })
})

describe('package output', () => {
  it('drops colour codes', () => {
    expect(plainLine('\x1b[32mInstalled npm:pi-plan\x1b[39m')).toBe('Installed npm:pi-plan')
    expect(plainLine('\x1b[2m\x1b[22m')).toBe('')
  })
})

describe('searchPiPackages', () => {
  it('asks npm for the pi-package keyword and keeps what the list shows', async () => {
    let asked = ''
    const results = await searchPiPackages(' web ', async (url) => {
      asked = url
      return {
        ok: true,
        status: 200,
        json: async () => ({
          objects: [
            { package: { name: 'pi-web-access', version: '0.37.0', description: 'Web search' }, downloads: { weekly: 230465 } },
            { package: {} }
          ]
        })
      }
    })
    expect(new URL(asked).searchParams.get('text')).toBe('keywords:pi-package web')
    expect(results).toEqual([{ name: 'pi-web-access', version: '0.37.0', description: 'Web search', weeklyDownloads: 230465 }])
  })

  it('reports a failed search', async () => {
    await expect(searchPiPackages('', async () => ({ ok: false, status: 503, json: async () => ({}) }))).rejects.toThrow('503')
  })
})

describe('run', () => {
  it('streams lines and reports the exit code', async () => {
    const script = join(root, 'say.cjs')
    writeFileSync(script, "console.log('one'); console.error('two'); process.stdout.write('three'); process.exit(3)")
    const lines: string[] = []
    const r = await run('node', [script], { cwd: root, onLine: (l, s) => lines.push(`${s}:${l}`) }).done
    expect(r.code).toBe(3)
    expect(lines.sort()).toEqual(['err:two', 'out:one', 'out:three'])
  })

  it('stops a run that takes too long', async () => {
    const script = join(root, 'wait.cjs')
    writeFileSync(script, 'setTimeout(() => {}, 60000)')
    const r = await run('node', [script], { cwd: root, timeoutMs: 300 }).done
    expect(r.timedOut).toBe(true)
  }, 15000)

  it('reports a command that is not there', async () => {
    const r = await run('agent-deck-no-such-command', [], { cwd: root }).done
    expect(r.code).not.toBe(0)
  })
})

describe('Pi reload', () => {
  const settings: AdapterSettings = { claudePath: 'claude', piPath: 'pi', permissionMode: 'acceptEdits', approvals: 'ask', piSubagentTools: [], piAutoCompaction: true }
  class FakePi extends PiAdapter {
    events: AgentEvent[] = []
    spawns: string[][] = []
    writes: any[] = []
    constructor() {
      const events: AgentEvent[] = []
      super((e) => events.push(e), settings)
      this.events = events
    }
    protected spawn(_c: string, args: string[]) {
      this.spawns.push(args)
    }
    protected write(obj: unknown) {
      this.writes.push(obj)
    }
    feed(...recs: any[]) {
      for (const r of recs) this.onRecord(r)
    }
  }

  it('restarts an idle tab and asks for its commands again', () => {
    const p = new FakePi()
    p.start({ agent: 'pi', cwd: 'C:\\w', model: 'a/b' })
    p.writes = []
    expect(p.reload()).toBe(true)
    expect(p.spawns).toHaveLength(2)
    expect(p.writes.map((w) => w.type)).toEqual(expect.arrayContaining(['set_model', 'get_commands']))
  })

  it('waits for a busy tab to finish its turn', () => {
    const p = new FakePi()
    p.start({ agent: 'pi', cwd: 'C:\\w' })
    p.feed({ type: 'agent_start' })
    expect(p.reload()).toBe(false)
    expect(p.spawns).toHaveLength(1)
    p.feed({ type: 'agent_settled' })
    expect(p.spawns).toHaveLength(2)
  })
})
