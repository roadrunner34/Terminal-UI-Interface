// ProcessAdapter.spawn: the SAFE_ARG guard applies only to shell launches.
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Launch } from '../src/main/resolve'
import type { AgentEvent } from '../src/shared/events'

const spawnMock = vi.fn()
let launch: Launch

vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }))
vi.mock('../src/main/resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/resolve')>()),
  resolveLaunch: () => launch
}))

const { PiAdapter } = await import('../src/main/agents/pi')

function fakeProc() {
  const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => {} })
  return Object.assign(new EventEmitter(), { stdout: stream(), stderr: stream(), stdin: { write() {}, end() {} } })
}

class SpawnPi extends PiAdapter {
  events: AgentEvent[]
  constructor() {
    const events: AgentEvent[] = []
    super((e) => events.push(e), { claudePath: 'claude', piPath: 'pi', permissionMode: 'acceptEdits', approvals: 'ask', piSubagentTools: [], piAutoCompaction: true })
    this.events = events
  }
  run(args: string[]) {
    this.spawn('pi', args, 'C:\\work')
  }
}

beforeEach(() => {
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => fakeProc())
})

describe('ProcessAdapter.spawn', () => {
  const args = ['--append-system-prompt', 'C:\\Users\\A B\\append.md', '--exclude-tools', 'mcp__*']

  it('passes any argument when the launch skips the shell', () => {
    launch = { command: 'C:\\node\\node.exe', args: ['C:\\pi\\cli.js', ...args], env: { PI_MANAGED_INSTALL_ROOT: 'C:\\pi' }, shell: false }
    new SpawnPi().run(args)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [command, argv, opts] = spawnMock.mock.calls[0]
    expect(command).toBe('C:\\node\\node.exe')
    expect(argv).toEqual(['C:\\pi\\cli.js', ...args])
    expect(opts.shell).toBeUndefined()
    expect(opts.env.PI_MANAGED_INSTALL_ROOT).toBe('C:\\pi')
  })

  it('refuses unsafe arguments when the launch needs the shell', () => {
    launch = { command: 'C:\\x\\pi.cmd', args, env: {}, shell: true }
    const pi = new SpawnPi()
    pi.run(args)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(pi.events[0]).toMatchObject({ kind: 'error' })
    expect(pi.events[1]).toEqual({ kind: 'exit', code: null })
  })

  it('builds a quoted command line for a safe shell launch', () => {
    launch = { command: 'C:\\Program Files\\x\\pi.cmd', args: ['--mode', 'rpc'], env: {}, shell: true }
    new SpawnPi().run(['--mode', 'rpc'])
    const [line, opts] = spawnMock.mock.calls[0]
    expect(line).toBe('"C:\\Program Files\\x\\pi.cmd" --mode rpc')
    expect(opts.shell).toBe(true)
  })
})
