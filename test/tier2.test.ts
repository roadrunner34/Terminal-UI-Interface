// Hooks, background tasks, context breakdown, rename, export, shell commands,
// forking and restoring files. Claude records come from a live `claude -p`
// 2.1.289 run (test/fixtures/claude-tier2.jsonl); Pi's follow docs/rpc-commands.md.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter, ClaudeTranslator, QUIET_HOOK_MS, claudeArgs } from '../src/main/agents/claude'
import { JsonlSplitter } from '../src/main/agents/jsonl'
import { PiAdapter } from '../src/main/agents/pi'
import type { AdapterSettings } from '../src/main/agents/types'
import type { AgentEvent } from '../src/shared/events'
import { applyEvent, initialState } from '../src/shared/session'

const settings: AdapterSettings = {
  claudePath: 'claude',
  piPath: 'pi',
  permissionMode: 'acceptEdits',
  approvals: 'ask',
  piSubagentTools: [],
  piAutoCompaction: true
}

function fixture(name: string): any[] {
  const recs: any[] = []
  const splitter = new JsonlSplitter((r) => recs.push(r))
  splitter.push(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
  splitter.end()
  return recs
}
const recorded = fixture('claude-tier2.jsonl')
const find = (pred: (r: any) => boolean) => recorded.find(pred)

function reduce(events: AgentEvent[]) {
  const s = initialState()
  for (const e of events) applyEvent(s, e, 1000)
  return s
}
const notices = (events: AgentEvent[]) => events.flatMap((e) => (e.kind === 'notice' ? [e.text] : []))

describe('Claude hooks', () => {
  const started = find((r) => r.subtype === 'hook_started')
  const response = find((r) => r.subtype === 'hook_response')

  it('keeps quick, successful hooks out of the transcript', () => {
    const t = new ClaudeTranslator(() => 0)
    expect([...t.handle(started), ...t.handle(response)]).toEqual([])
  })

  it('shows a slow hook as a finished Hook row', () => {
    let now = 0
    const t = new ClaudeTranslator(() => now)
    t.handle(started)
    now = QUIET_HOOK_MS + 1
    const s = reduce(t.handle(response))
    expect(s.transcripts.main).toEqual([expect.objectContaining({ type: 'tool', name: 'Hook', status: 'done', input: { description: 'SessionStart:startup' } })])
  })

  it('shows a failing hook with what it printed', () => {
    const t = new ClaudeTranslator(() => 0)
    t.handle({ ...started, hook_id: 'h2', hook_name: 'PreToolUse:Bash' })
    const s = reduce(
      t.handle({ ...response, hook_id: 'h2', hook_name: 'PreToolUse:Bash', outcome: 'error', exit_code: 2, stdout: '', stderr: 'Blocked: rm -rf' })
    )
    expect(s.transcripts.main[0]).toMatchObject({ name: 'Hook', status: 'error', output: 'Blocked: rm -rf' })
  })
})

describe('Claude background tasks', () => {
  it('gives a backgrounded shell command a stoppable card that ends with its summary', () => {
    const t = new ClaudeTranslator()
    const events = recorded.filter((r) => r.type === 'assistant' || r.subtype?.startsWith('task_')).flatMap((r) => t.handle(r))
    const s = reduce(events)
    const card = s.subagents['task:bpa8bt9ab']
    expect(card).toMatchObject({ label: 'Sleep for 4 seconds then echo done-bg', agentType: 'background shell', taskId: 'bpa8bt9ab', status: 'done' })
    expect(s.transcripts['task:bpa8bt9ab']).toEqual([
      expect.objectContaining({ type: 'assistant', text: 'Background command "Sleep for 4 seconds then echo done-bg" completed (exit code 0)' })
    ])
  })

  it('keeps a backgrounded subagent running past its tool result and the end of the turn', () => {
    const t = new ClaudeTranslator()
    const events = [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'Audit', run_in_background: true } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'tk1', tool_use_id: 'ag1', is_backgrounded: true, task_type: 'local_agent' },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'Running in the background' }] } },
      { type: 'result', subtype: 'success' }
    ].flatMap((r) => t.handle(r))
    const s = reduce(events)
    expect(s.subagents.ag1).toMatchObject({ status: 'running', taskId: 'tk1' })
    for (const e of t.handle({ type: 'system', subtype: 'task_notification', task_id: 'tk1', status: 'completed', summary: 'Audit done' }))
      applyEvent(s, e)
    expect(s.subagents.ag1.status).toBe('done')
  })

  it('treats init as the start of a turn, including ones Claude starts itself', () => {
    const t = new ClaudeTranslator()
    const s = reduce(t.handle({ type: 'system', subtype: 'init', session_id: 's' }))
    expect(s.busy).toBe(true)
  })
})

describe('Claude session details', () => {
  it('reads the context breakdown', () => {
    const t = new ClaudeTranslator()
    const s = reduce(t.handle(find((r) => r.response?.request_id === 'ctx-1')))
    expect(s.contextUsage).toMatchObject({ total: 26886, max: 200000 })
    expect(s.contextUsage!.categories).toContainEqual({ name: 'Free space', tokens: 173114, kind: 'free' })
    expect(s.contextUsage!.categories).toContainEqual({ name: 'MCP tools (deferred)', tokens: 50904, kind: 'deferred' })
  })

  it('follows the session title', () => {
    const t = new ClaudeTranslator()
    expect(reduce(t.handle(find((r) => r.subtype === 'session_title_changed'))).title).toBe('recorder-test')
  })

  it('reports a refused tool call (recorded)', () => {
    const t = new ClaudeTranslator()
    expect(notices(t.handle(find((r) => r.subtype === 'permission_denied')))).toEqual(['Bash was denied: This command requires approval'])
  })
})

class FakeClaude extends ClaudeAdapter {
  events: AgentEvent[] = []
  writes: any[] = []
  spawns: { args: string[]; env: Record<string, string> }[] = []
  constructor() {
    const events: AgentEvent[] = []
    super((e) => events.push(e), settings)
    this.events = events
  }
  protected spawn(_command: string, args: string[], _cwd: string, env: Record<string, string> = {}) {
    this.spawns.push({ args, env })
  }
  protected write(obj: unknown) {
    this.writes.push(obj)
  }
  feed(...recs: any[]) {
    for (const r of recs) this.onRecord(r)
  }
  take() {
    const w = this.writes
    this.writes = []
    return w
  }
  /** One full turn: Claude starts, replies with assistant message `uuid`, ends. */
  turn(uuid: string) {
    this.feed(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'assistant', uuid, message: { id: uuid, content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', subtype: 'success' }
    )
  }
}

const entryIds = (events: AgentEvent[]) => events.flatMap((e) => (e.kind === 'user-message' && e.entryId ? [e.entryId] : []))

describe('Claude fork and restore', () => {
  it('names each prompt with a uuid and turns file checkpoints on', () => {
    const c = new FakeClaude()
    c.start({ agent: 'claude', cwd: '.' })
    expect(c.spawns[0].env).toEqual({ CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' })
    c.send('hello')
    const [id] = entryIds(c.events)
    expect(c.writes.at(-1)).toMatchObject({ type: 'user', uuid: id })
  })

  it('forks onto a copy of the session cut off before the chosen prompt', () => {
    const c = new FakeClaude()
    c.start({ agent: 'claude', cwd: '.' })
    c.send('first')
    c.turn('a1')
    c.send('second')
    c.turn('a2')
    const [, second] = entryIds(c.events)
    c.fork(second)
    expect(c.spawns.at(-1)!.args.join(' ')).toContain('--resume sess-1 --fork-session --resume-session-at=a1')
    const s = reduce(c.events)
    expect(s.transcripts.main.filter((b) => b.type === 'user').map((b: any) => b.text)).toEqual(['first'])
    expect(c.events).toContainEqual({ kind: 'draft', text: 'second' })
  })

  it('forking from the first prompt starts fresh', () => {
    const c = new FakeClaude()
    c.start({ agent: 'claude', cwd: '.' })
    c.send('first')
    c.turn('a1')
    c.fork(entryIds(c.events)[0])
    expect(c.spawns.at(-1)!.args).not.toContain('--resume')
  })

  it('asks Claude for hook events', () => {
    expect(claudeArgs(settings, { model: '', effort: '', mode: 'auto' })).toContain('--include-hook-events')
  })

  it('builds the fork arguments only with a session to resume', () => {
    expect(claudeArgs(settings, { model: '', effort: '', mode: 'auto' }, undefined, 'a1')).not.toContain('--fork-session')
    expect(claudeArgs(settings, { model: '', effort: '', mode: 'auto' }, 's', '')).toContain('--fork-session')
  })

  it('restores files after the user agrees to what the dry run found', () => {
    const c = new FakeClaude()
    c.start({ agent: 'claude', cwd: '.' })
    c.send('edit notes')
    c.turn('a1')
    c.take()
    c.rewind(entryIds(c.events)[0])
    const [dry] = c.take()
    expect(dry.request).toMatchObject({ subtype: 'rewind_files', dry_run: true })
    const dryReply = find((r) => r.response?.request_id === 'rewind-dry-1')
    c.feed({ ...dryReply, response: { ...dryReply.response, request_id: dry.request_id } })
    const ask = c.events.find((e) => e.kind === 'prompt-request') as Extract<AgentEvent, { kind: 'prompt-request' }>
    expect(ask.prompt).toMatchObject({ type: 'confirm', title: 'Restore 1 file to before this message?' })
    expect((ask.prompt as any).message).toContain('notes.txt (+1 −1)')

    c.answerPrompt(ask.id, { confirmed: true })
    const [go] = c.take()
    expect(go.request).toEqual({ subtype: 'rewind_files', user_message_id: entryIds(c.events)[0] })
    const goReply = find((r) => r.response?.request_id === 'rewind-go-3')
    c.feed({ ...goReply, response: { ...goReply.response, request_id: go.request_id } })
    expect(notices(c.events)).toContain('Restored files to how they were before that message.')
  })

  it('says why files can’t be restored', () => {
    const c = new FakeClaude()
    c.start({ agent: 'claude', cwd: '.' })
    c.send('x')
    c.turn('a1')
    c.take()
    c.rewind(entryIds(c.events)[0])
    const [dry] = c.take()
    const off = find((r) => r.response?.request_id === 'rw-1')
    c.feed({ ...off, response: { ...off.response, request_id: dry.request_id } })
    expect(notices(c.events)).toContain("Can't restore files: File rewinding is not enabled.")
  })

  it('sends rename, stop and context requests over the control channel', () => {
    const c = new FakeClaude()
    c.start({ agent: 'claude', cwd: '.' })
    c.take()
    c.rename('Bug bash')
    c.stopTask('bpa8bt9ab')
    c.contextUsage()
    expect(c.take().map((w) => w.request)).toEqual([
      { subtype: 'rename_session', title: 'Bug bash', source: 'host' },
      { subtype: 'stop_task', task_id: 'bpa8bt9ab' },
      { subtype: 'get_context_usage' }
    ])
  })
})

class FakePi extends PiAdapter {
  events: AgentEvent[] = []
  writes: any[] = []
  constructor() {
    const events: AgentEvent[] = []
    super((e) => events.push(e), settings)
    this.events = events
  }
  protected spawn() {}
  protected write(obj: unknown) {
    this.writes.push(obj)
  }
  feed(...recs: any[]) {
    for (const r of recs) this.onRecord(r)
  }
  take() {
    const w = this.writes
    this.writes = []
    return w
  }
}

describe('Pi shell commands', () => {
  it('streams a !command into a bash row and ends the turn with its exit code', () => {
    const p = new FakePi()
    p.shell('ls -la')
    const [cmd] = p.take()
    expect(cmd).toMatchObject({ type: 'bash', command: 'ls -la' })
    p.feed(
      { type: 'bash_execution_update', id: cmd.id, delta: 'a.txt\n' },
      { type: 'bash_execution_update', id: cmd.id, delta: 'b.txt\n' },
      { type: 'response', id: cmd.id, command: 'bash', success: true, data: { output: 'a.txt\nb.txt\n', exitCode: 1, cancelled: false } }
    )
    const s = reduce(p.events)
    expect(s.transcripts.main).toEqual([expect.objectContaining({ type: 'tool', name: 'bash', status: 'error', output: 'a.txt\nb.txt\n' })])
    expect(s.busy).toBe(false)
  })

  it('interrupting stops the command', () => {
    const p = new FakePi()
    p.shell('sleep 100')
    p.take()
    p.abort()
    expect(p.take().map((w) => w.type)).toContain('abort_bash')
  })
})

describe('Pi fork, rename and export', () => {
  it('finds the right repeat of a prompt in get_fork_messages and forks there', () => {
    const p = new FakePi()
    p.send('again')
    p.feed({ type: 'agent_settled' })
    p.send('again')
    p.feed({ type: 'agent_settled' })
    const [, second] = entryIds(p.events)
    p.take()
    p.fork(second)
    expect(p.take()).toEqual([expect.objectContaining({ type: 'get_fork_messages' })])
    p.feed({
      type: 'response',
      command: 'get_fork_messages',
      success: true,
      data: { messages: [{ entryId: 'e1', text: 'again' }, { entryId: 'e2', text: 'again' }] }
    })
    expect(p.take()).toEqual([expect.objectContaining({ type: 'fork', entryId: 'e2' })])
    p.feed({ type: 'response', command: 'fork', success: true, data: { text: 'again', cancelled: false } })
    const s = reduce(p.events)
    expect(s.transcripts.main.filter((b) => b.type === 'user')).toHaveLength(1)
    expect(p.events).toContainEqual({ kind: 'draft', text: 'again' })
    expect(p.take().map((w) => w.type)).toEqual(['get_state', 'get_session_stats'])
  })

  it('renames the session and follows renames from elsewhere', () => {
    const p = new FakePi()
    p.rename('Refactor')
    expect(p.take()).toEqual([expect.objectContaining({ type: 'set_session_name', name: 'Refactor' })])
    p.feed({ type: 'session_info_changed', name: 'Refactor 2' })
    expect(reduce(p.events).title).toBe('Refactor 2')
  })

  it('exports to the chosen path and says where', () => {
    const p = new FakePi()
    p.exportSession('D:\\out\\s.html')
    const [cmd] = p.take()
    expect(cmd).toMatchObject({ type: 'export_html', outputPath: 'D:\\out\\s.html' })
    p.feed({ type: 'response', id: cmd.id, command: 'export_html', success: true, data: { path: 'D:\\out\\s.html' } })
    expect(notices(p.events)).toEqual(['Exported the session to D:\\out\\s.html.'])
  })
})

describe('Fork in the reducer', () => {
  it('drops the turns after the fork point and the finished subagents they launched', () => {
    const s = reduce([
      { kind: 'user-message', text: 'one', entryId: 'u1' },
      { kind: 'tool-start', scope: 'main', toolId: 'ag1', name: 'Agent', input: {} },
      { kind: 'subagent-start', subagentId: 'ag1', label: 'kept', agentType: 'Explore' },
      { kind: 'subagent-end', subagentId: 'ag1', status: 'done' },
      { kind: 'user-message', text: 'two', entryId: 'u2' },
      { kind: 'tool-start', scope: 'main', toolId: 'ag2', name: 'Agent', input: {} },
      { kind: 'subagent-start', subagentId: 'ag2', label: 'dropped', agentType: 'Explore' },
      { kind: 'subagent-end', subagentId: 'ag2', status: 'done' },
      { kind: 'tool-start', scope: 'main', toolId: 'ag3', name: 'Agent', input: {} },
      { kind: 'subagent-start', subagentId: 'ag3', label: 'still running', agentType: 'Explore' },
      { kind: 'truncate', entryId: 'u2' }
    ])
    expect(s.transcripts.main.map((b) => b.id)).toEqual([expect.any(String), 'ag1'])
    expect(Object.keys(s.subagents).sort()).toEqual(['ag1', 'ag3'])
  })
})
