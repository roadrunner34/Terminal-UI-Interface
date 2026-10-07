// Live MCP management. Claude records come from a live `claude -p` 2.1.292
// run (test/fixtures/claude-mcp.jsonl, trimmed to three servers; Gmail's
// "failed" state was edited in to cover errors). Pi's list follows
// `pi mcp list --json` in pi 1.0.4 (dist/extensions/mcp/cli.js).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter, ClaudeTranslator, MCP_AUTH_POLL_MAX, MCP_AUTH_POLL_MS, mcpRequest, mcpStatusFrom } from '../src/main/agents/claude'
import { JsonlSplitter } from '../src/main/agents/jsonl'
import { piMcpServers } from '../src/main/agents/pi'
import type { AdapterSettings } from '../src/main/agents/types'
import type { AgentEvent } from '../src/shared/events'
import { applyEvent, initialState } from '../src/shared/session'

const recs: any[] = []
const splitter = new JsonlSplitter((r) => recs.push(r))
splitter.push(readFileSync(join(__dirname, 'fixtures', 'claude-mcp.jsonl'), 'utf8'))
splitter.end()
const [pendingStatus, connectedStatus, notFound] = recs

const settings: AdapterSettings = {
  claudePath: 'claude',
  piPath: 'pi',
  permissionMode: 'acceptEdits',
  approvals: 'ask',
  piSubagentTools: [],
  piAutoCompaction: true
}

class FakeClaude extends ClaudeAdapter {
  events: AgentEvent[] = []
  writes: any[] = []
  opened: string[] = []
  constructor() {
    const events: AgentEvent[] = []
    const opened: string[] = []
    super((e) => events.push(e), { ...settings, openUrl: (u) => opened.push(u) })
    this.events = events
    this.opened = opened
  }
  protected spawn() {}
  protected write(obj: unknown) {
    this.writes.push(obj)
  }
  feed(...rs: any[]) {
    for (const r of rs) this.onRecord(r)
  }
  take() {
    const w = this.writes
    this.writes = []
    return w
  }
  /** Answers the last request with `response`, using its id. */
  answer(response: Record<string, unknown>) {
    const id = this.writes.at(-1).request_id
    this.feed({ type: 'control_response', response: { request_id: id, ...response } })
    return id as string
  }
  notices() {
    return this.events.flatMap((e) => (e.kind === 'notice' ? [e.text] : []))
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Claude mcp_status', () => {
  it('reads every server, with version, scope, transport and tools', () => {
    const servers = mcpStatusFrom(connectedStatus.response.response)
    expect(servers[0]).toEqual({
      name: 'plugin:playwright:playwright',
      status: 'connected',
      version: '1.64.0-alpha-1790635538000',
      scope: 'dynamic',
      source: 'plugin',
      transport: 'stdio',
      tools: [{ name: 'browser_close' }, { name: 'browser_console_messages', readOnly: true }, { name: 'browser_snapshot', readOnly: true }]
    })
    expect(servers[1]).toMatchObject({ name: 'plugin:context7:context7', status: 'needs-auth', transport: 'http' })
    expect(servers[2]).toMatchObject({ status: 'failed', error: 'Connection failed', transport: 'claudeai-proxy' })
  })

  it('turns a status reply into an mcp event', () => {
    const [e] = new ClaudeTranslator().handle(pendingStatus)
    expect(e).toMatchObject({ kind: 'mcp', servers: [{ status: 'pending' }, { status: 'needs-auth' }, { status: 'pending' }] })
  })

  it('keeps status details when init later names the servers only', () => {
    const s = initialState()
    applyEvent(s, { kind: 'mcp', servers: mcpStatusFrom(connectedStatus.response.response) })
    applyEvent(s, { kind: 'mcp-busy', name: 'plugin:playwright:playwright', busy: true })
    applyEvent(s, { kind: 'mcp', servers: [{ name: 'plugin:playwright:playwright', status: 'connected' }] })
    expect(s.mcp).toEqual([expect.objectContaining({ version: '1.64.0-alpha-1790635538000', busy: true, tools: expect.any(Array) })])
  })

  it('asks for status as soon as it starts', () => {
    const c = new FakeClaude()
    c.start({ agent: 'claude', cwd: 'C:\\work' })
    expect(c.take()).toEqual([{ type: 'control_request', request_id: expect.stringMatching(/^mcp-status-/), request: { subtype: 'mcp_status' } }])
  })
})

describe('Claude MCP actions', () => {
  it.each([
    ['reconnect', { subtype: 'mcp_reconnect', serverName: 'gh' }],
    ['enable', { subtype: 'mcp_toggle', serverName: 'gh', enabled: true }],
    ['disable', { subtype: 'mcp_toggle', serverName: 'gh', enabled: false }],
    ['auth', { subtype: 'mcp_authenticate', serverName: 'gh' }],
    ['logout', { subtype: 'mcp_clear_auth', serverName: 'gh' }]
  ] as const)('sends %s as the CLI names it', (action, body) => {
    expect(mcpRequest(action, 'gh')).toEqual(body)
    const c = new FakeClaude()
    c.mcp(action, 'gh')
    expect(c.take()).toEqual([{ type: 'control_request', request_id: expect.stringMatching(new RegExp(`^mcp-${action}-`)), request: body }])
    expect(c.events).toEqual([{ kind: 'mcp-busy', name: 'gh', busy: true }])
  })

  it('reports success, clears busy and refreshes the list', () => {
    const c = new FakeClaude()
    c.mcp('disable', 'gh')
    c.answer({ subtype: 'success', response: {} })
    expect(c.events).toContainEqual({ kind: 'mcp-busy', name: 'gh', busy: false })
    expect(c.notices()).toEqual(['Disabled gh. This is saved to your Claude settings.'])
    expect(c.writes.at(-1).request).toEqual({ subtype: 'mcp_status' })
  })

  it("shows the CLI's error as a notice on that server, not a session error", () => {
    const c = new FakeClaude()
    c.mcp('reconnect', 'no-such-server')
    c.answer({ subtype: 'error', error: notFound.response.error })
    expect(c.events.find((e) => e.kind === 'error')).toBeUndefined()
    expect(c.notices()).toEqual(['no-such-server: Server not found: no-such-server'])
    expect(c.writes.at(-1).request).toEqual({ subtype: 'mcp_status' })
  })

  it('opens an https sign-in page and watches until the server connects', () => {
    vi.useFakeTimers()
    const c = new FakeClaude()
    c.mcp('auth', 'plugin:context7:context7')
    c.answer({ subtype: 'success', response: { authUrl: 'https://mcp.context7.com/authorize?x=1', requiresUserAction: true, callbackExpected: true, redirectScheme: 'http' } })
    expect(c.opened).toEqual(['https://mcp.context7.com/authorize?x=1'])
    c.take()
    vi.advanceTimersByTime(MCP_AUTH_POLL_MS)
    expect(c.writes.map((w) => w.request.subtype)).toEqual(['mcp_status'])
    // Still waiting: needs-auth.
    c.answer({ subtype: 'success', response: { mcpServers: [{ name: 'plugin:context7:context7', status: 'needs-auth' }] } })
    vi.advanceTimersByTime(MCP_AUTH_POLL_MS)
    c.answer({ subtype: 'success', response: { mcpServers: [{ name: 'plugin:context7:context7', status: 'connected' }] } })
    expect(c.notices().at(-1)).toBe('Signed in to plugin:context7:context7.')
    c.take()
    vi.advanceTimersByTime(MCP_AUTH_POLL_MS * 3)
    expect(c.take()).toEqual([])
  })

  it('gives up watching after the limit', () => {
    vi.useFakeTimers()
    const c = new FakeClaude()
    c.mcp('auth', 'x')
    c.answer({ subtype: 'success', response: { authUrl: 'https://example.com/a' } })
    vi.advanceTimersByTime(MCP_AUTH_POLL_MS * (MCP_AUTH_POLL_MAX + 2))
    expect(c.notices().at(-1)).toMatch(/^Still waiting on the sign-in for x/)
  })

  it('never opens a non-https URL', () => {
    const c = new FakeClaude()
    c.mcp('auth', 'x')
    c.answer({ subtype: 'success', response: { authUrl: 'file:///C:/evil.html' } })
    expect(c.opened).toEqual([])
    expect(c.notices()).toEqual(['Sign in to x at file:///C:/evil.html'])
  })

  it('sends custom-scheme sign-ins to the terminal', () => {
    const c = new FakeClaude()
    c.mcp('auth', 'x')
    c.answer({ subtype: 'success', response: { authUrl: 'https://example.com/a', callbackExpected: true, redirectScheme: 'custom' } })
    expect(c.opened).toEqual([])
    expect(c.notices()).toEqual(['Finish signing in to x with `claude /mcp` in a terminal.'])
  })
})

describe('Pi mcp list --json', () => {
  it('reads servers, disabled entries and config errors', () => {
    const out = JSON.stringify({
      servers: [
        { name: 'fs', scope: 'global', enabled: true, exposure: 'codemode', transport: 'stdio', state: 'connected', tools: ['read_file', 'list_dir'] },
        { name: 'docs', scope: 'project', enabled: true, transport: 'http', state: 'needs-auth', tools: [], error: 'Sign-in required' },
        { name: 'off', scope: 'global', enabled: false, transport: 'stdio', state: 'disabled', tools: [] }
      ],
      errors: [{ name: 'bad', message: 'url entry has no type' }]
    })
    expect(piMcpServers(out)).toEqual([
      { name: 'fs', status: 'connected', scope: 'global', transport: 'stdio', tools: [{ name: 'read_file' }, { name: 'list_dir' }] },
      { name: 'docs', status: 'needs-auth', error: 'Sign-in required', scope: 'project', transport: 'http', tools: [] },
      { name: 'off', status: 'disabled', scope: 'global', transport: 'stdio', tools: [] },
      { name: 'bad', status: 'invalid', error: 'url entry has no type' }
    ])
  })

  it('returns null for anything else', () => {
    expect(piMcpServers('No MCP servers configured.')).toBeNull()
    expect(piMcpServers('{"x":1}')).toBeNull()
  })
})
