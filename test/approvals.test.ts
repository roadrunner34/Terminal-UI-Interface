// Tool approvals and agent questions. The Claude records follow a live run of
// Claude Code 2.1.289 with --permission-prompt-tool stdio; the Pi records
// follow pi's docs/rpc-extension-ui.md.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter, ClaudeTranslator, claudeArgs } from '../src/main/agents/claude'
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

class FakeClaude extends ClaudeAdapter {
  events: AgentEvent[] = []
  writes: any[] = []
  constructor(s: AdapterSettings = settings) {
    const events: AgentEvent[] = []
    super((e) => events.push(e), s)
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
  kinds() {
    return this.events.map((e) => e.kind)
  }
}

class FakePi extends PiAdapter {
  events: AgentEvent[] = []
  writes: any[] = []
  constructor(s: AdapterSettings = settings) {
    const events: AgentEvent[] = []
    super((e) => events.push(e), s)
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

const canUse = (id: string, tool_name: string, input: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'control_request',
  request_id: id,
  request: { subtype: 'can_use_tool', tool_name, display_name: tool_name, input, tool_use_id: `tu-${id}`, ...extra }
})

describe('Claude permission requests', () => {
  const recs = fixture('claude-permission.jsonl')
  const req = recs.find((r) => r.type === 'control_request')

  it('only asks for prompts when approvals are on', () => {
    const on = claudeArgs(settings, { model: '', effort: '', mode: 'auto' }).join(' ')
    const off = claudeArgs({ ...settings, approvals: 'deny' }, { model: '', effort: '', mode: 'auto' }).join(' ')
    expect(on).toContain('--permission-prompt-tool stdio')
    expect(off).not.toContain('--permission-prompt-tool')
  })

  it('turns a real can_use_tool request into a tool-approval prompt', () => {
    const t = new ClaudeTranslator()
    const events = recs.flatMap((r) => t.handle(r))
    const prompt = events.find((e) => e.kind === 'prompt-request')
    expect(prompt).toEqual({
      kind: 'prompt-request',
      id: req.request_id,
      scope: 'main',
      prompt: {
        type: 'tool-approval',
        tool: 'Bash',
        input: req.request.input,
        description: req.request.description,
        canAlways: true
      }
    })
  })

  it('places a subagent tool request in that subagent', () => {
    const t = new ClaudeTranslator()
    t.handle({
      type: 'assistant',
      parent_tool_use_id: 'agent-1',
      message: { id: 'm', content: [{ type: 'tool_use', id: 'tu-r1', name: 'Bash', input: { command: 'rm x' } }] }
    })
    const [e] = t.handle(canUse('r1', 'Bash', { command: 'rm x' }))
    expect(e).toMatchObject({ kind: 'prompt-request', scope: { subagentId: 'agent-1' } })
  })

  it('allows with the original input', () => {
    const c = new FakeClaude()
    c.feed(req)
    c.answerPrompt(req.request_id, { allow: true })
    expect(c.take()).toEqual([
      {
        type: 'control_response',
        response: { subtype: 'success', request_id: req.request_id, response: { behavior: 'allow', updatedInput: req.request.input } }
      }
    ])
    expect(c.events.at(-1)).toEqual({ kind: 'prompt-resolved', id: req.request_id })
  })

  it('allows for the session with Claude’s own suggested rule', () => {
    const c = new FakeClaude()
    c.feed(req)
    c.answerPrompt(req.request_id, { allow: true, always: true })
    const response = c.take()[0].response.response
    expect(response.updatedPermissions).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch created-by-agent.txt' }], behavior: 'allow', destination: 'session' }
    ])
  })

  it('denies, and ignores answers to requests it no longer holds', () => {
    const c = new FakeClaude()
    c.feed(req)
    c.answerPrompt(req.request_id, { allow: false })
    expect(c.take()[0].response.response).toEqual({ behavior: 'deny', message: 'The user denied this tool call.' })
    c.answerPrompt(req.request_id, { allow: true })
    expect(c.take()).toEqual([])
  })

  it('answers AskUserQuestion with the chosen labels', () => {
    const input = {
      questions: [{ question: 'Favorite color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }]
    }
    const c = new FakeClaude()
    c.feed(canUse('q1', 'AskUserQuestion', input))
    expect(c.events.find((e) => e.kind === 'prompt-request')).toMatchObject({
      prompt: { type: 'questions', questions: [{ question: 'Favorite color?', header: 'Color', multiSelect: false }] }
    })
    c.answerPrompt('q1', { answers: { 'Favorite color?': 'Blue' } })
    expect(c.take()[0].response.response).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Favorite color?': 'Blue' } }
    })
  })

  it('drops prompts Claude cancels or that outlive the turn', () => {
    const c = new FakeClaude()
    c.feed(canUse('a', 'Bash', {}), canUse('b', 'Write', {}))
    c.feed({ type: 'control_cancel_request', request_id: 'a' })
    c.feed({ type: 'result', subtype: 'success' })
    const resolved = c.events.flatMap((e) => (e.kind === 'prompt-resolved' ? [e.id] : []))
    expect(resolved).toEqual(['a', 'b'])
    c.answerPrompt('b', { allow: true })
    expect(c.take()).toEqual([])
  })

  it('releases pending prompts before interrupting', () => {
    const c = new FakeClaude()
    c.feed(canUse('a', 'Bash', {}))
    c.abort()
    const [deny, interrupt] = c.take()
    expect(deny.response.response.behavior).toBe('deny')
    expect(interrupt.request.subtype).toBe('interrupt')
  })
})

describe('Claude plan approval through ExitPlanMode', () => {
  const exit = canUse('plan-1', 'ExitPlanMode', { plan: '1. Do it' })

  function planning() {
    const c = new FakeClaude()
    c.start({ agent: 'claude', cwd: 'D:\\proj', mode: 'plan' })
    c.send('Plan it')
    c.take()
    c.events.length = 0
    c.feed(exit)
    return c
  }

  it('ends the turn in the UI instead of showing a prompt card', () => {
    const c = planning()
    expect(c.kinds()).toEqual(['turn-end'])
  })

  it('approving allows ExitPlanMode and switches to the auto permission mode', () => {
    const c = planning()
    c.approvePlan()
    const [allow, mode] = c.take()
    expect(allow.response).toMatchObject({ request_id: 'plan-1', response: { behavior: 'allow', updatedInput: { plan: '1. Do it' } } })
    expect(mode.request).toEqual({ subtype: 'set_permission_mode', mode: 'acceptEdits' })
    expect(c.kinds()).toContain('turn-start')
  })

  it('a reply refines the plan instead of starting a new prompt', () => {
    const c = planning()
    c.send('Also add tests')
    const writes = c.take()
    expect(writes).toHaveLength(1)
    expect(writes[0].response.response).toEqual({
      behavior: 'deny',
      message: 'The user wants changes before running the plan: Also add tests'
    })
  })

  it('without a pending ExitPlanMode, approving sends the approval as a message', () => {
    const c = new FakeClaude()
    c.start({ agent: 'claude', cwd: 'D:\\proj', mode: 'plan' })
    c.take()
    c.approvePlan()
    expect(c.take().some((w) => w.type === 'user')).toBe(true)
  })
})

describe('Pi extension dialogs', () => {
  afterEach(() => vi.useRealTimers())

  const ui = (id: string, method: string, extra: Record<string, unknown> = {}) => ({
    type: 'extension_ui_request',
    id,
    method,
    ...extra
  })

  function started(s: AdapterSettings = settings) {
    const pi = new FakePi(s)
    pi.start({ agent: 'pi', cwd: 'D:\\proj' })
    pi.take()
    return pi
  }

  it('turns each dialog kind into a prompt', () => {
    const pi = started()
    pi.feed(
      ui('s', 'select', { title: 'Pick', options: ['A', 'B'] }),
      ui('c', 'confirm', { title: 'Sure?', message: 'Really' }),
      ui('i', 'input', { title: 'Name', placeholder: 'x' }),
      ui('e', 'editor', { title: 'Edit', prefill: 'text' })
    )
    const prompts = pi.events.flatMap((e) => (e.kind === 'prompt-request' ? [e.prompt] : []))
    expect(prompts).toEqual([
      { type: 'select', title: 'Pick', options: ['A', 'B'] },
      { type: 'confirm', title: 'Sure?', message: 'Really' },
      { type: 'input', title: 'Name', placeholder: 'x', prefill: undefined, multiline: false },
      { type: 'input', title: 'Edit', placeholder: undefined, prefill: 'text', multiline: true }
    ])
  })

  it('answers in the shape each dialog expects', () => {
    const pi = started()
    pi.feed(ui('s', 'select', { title: 'Pick', options: ['A'] }), ui('c', 'confirm', { title: 'Sure?' }), ui('i', 'input', { title: 'N' }))
    pi.answerPrompt('s', { value: 'A' })
    pi.answerPrompt('c', { confirmed: false })
    pi.answerPrompt('i', { cancelled: true })
    expect(pi.take()).toEqual([
      { type: 'extension_ui_response', id: 's', value: 'A' },
      { type: 'extension_ui_response', id: 'c', confirmed: false },
      { type: 'extension_ui_response', id: 'i', cancelled: true }
    ])
  })

  it('refuses dialogs right away when approvals are off', () => {
    const pi = started({ ...settings, approvals: 'deny' })
    pi.feed(ui('c', 'confirm', { title: 'Sure?' }))
    expect(pi.take()).toEqual([{ type: 'extension_ui_response', id: 'c', cancelled: true }])
    expect(pi.events.some((e) => e.kind === 'prompt-request')).toBe(false)
  })

  it('drops the card when Pi times the dialog out', () => {
    vi.useFakeTimers()
    const pi = started()
    pi.feed(ui('c', 'confirm', { title: 'Sure?', timeout: 5000 }))
    vi.advanceTimersByTime(5000)
    expect(pi.events.at(-1)).toEqual({ kind: 'prompt-resolved', id: 'c' })
    pi.answerPrompt('c', { confirmed: true })
    expect(pi.take()).toEqual([])
  })

  it('cancels open dialogs on abort', () => {
    const pi = started()
    pi.feed(ui('c', 'confirm', { title: 'Sure?' }))
    pi.abort()
    expect(pi.take()).toEqual([{ type: 'extension_ui_response', id: 'c', cancelled: true }, expect.objectContaining({ type: 'abort' })])
  })

  it('shows notify as a notice and leaves pi-plan’s dialog to plan approval', () => {
    const pi = started()
    pi.feed(
      ui('n', 'notify', { message: 'Command blocked' }),
      { type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Plan: 1. x' }] } },
      ui('p', 'select', { title: 'Plan mode — what next?', options: ['Execute the plan', 'Stay in plan mode'] })
    )
    expect(pi.events).toContainEqual({ kind: 'notice', text: 'Command blocked' })
    expect(pi.events.some((e) => e.kind === 'prompt-request')).toBe(false)
  })
})

describe('Pi prompts', () => {
  function started() {
    const pi = new FakePi()
    pi.start({ agent: 'pi', cwd: 'D:\\proj' })
    pi.take()
    return pi
  }

  it('steers a prompt sent mid-turn instead of having Pi reject it', () => {
    const pi = started()
    pi.send('first')
    pi.feed({ type: 'agent_start' })
    pi.send('also check the tests')
    const prompts = pi.take().filter((w) => w.type === 'prompt')
    expect(prompts[0].streamingBehavior).toBeUndefined()
    expect(prompts[1]).toMatchObject({ message: 'also check the tests', streamingBehavior: 'steer' })
  })

  it('sends images in Pi’s shape', () => {
    const pi = started()
    pi.send('what is this?', [{ mimeType: 'image/png', data: 'AAA' }])
    expect(pi.take().find((w) => w.type === 'prompt')).toMatchObject({
      message: 'what is this?',
      images: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }]
    })
    expect(pi.events.find((e) => e.kind === 'user-message')).toMatchObject({ images: [{ mimeType: 'image/png', data: 'AAA' }] })
  })

  it('lists Pi’s commands', () => {
    const pi = started()
    pi.feed({ type: 'response', command: 'get_commands', success: true, data: { commands: [{ name: 'fix-tests', description: 'Fix failing tests' }] } })
    expect(pi.events).toContainEqual({ kind: 'commands', commands: [{ name: 'fix-tests', description: 'Fix failing tests' }] })
  })
})

describe('Pending prompts in the session', () => {
  const request: AgentEvent = { kind: 'prompt-request', id: 'p1', scope: 'main', prompt: { type: 'confirm', title: 'Sure?' } }

  it('holds a prompt until it is resolved, even across turn-end', () => {
    const s = initialState()
    applyEvent(s, request)
    applyEvent(s, request)
    applyEvent(s, { kind: 'turn-end' })
    expect(s.prompts.map((p) => p.id)).toEqual(['p1'])
    applyEvent(s, { kind: 'prompt-resolved', id: 'p1' })
    expect(s.prompts).toEqual([])
  })

  it('clears prompts when the agent exits', () => {
    const s = initialState()
    applyEvent(s, request)
    applyEvent(s, { kind: 'exit', code: 1 })
    expect(s.prompts).toEqual([])
  })

  it('ends subagents still running when the agent exits, leaving finished ones as they were', () => {
    const s = initialState()
    applyEvent(s, { kind: 'subagent-start', subagentId: 'a', label: 'A', agentType: 'background agent' }, 1000)
    applyEvent(s, { kind: 'subagent-start', subagentId: 'b', label: 'B', agentType: 'subagent' }, 1000)
    applyEvent(s, { kind: 'subagent-end', subagentId: 'b', status: 'done' }, 2000)
    applyEvent(s, { kind: 'exit', code: 0 }, 5000)
    expect(s.subagents.a).toMatchObject({ status: 'error', endedAt: 5000, lastActivity: 'Session ended' })
    expect(s.subagents.b).toMatchObject({ status: 'done', endedAt: 2000 })
  })
})
