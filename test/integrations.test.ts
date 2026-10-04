// Retries, compaction, follow-up queueing, usage limits and MCP health.
// Claude record shapes follow a live `claude -p` 2.1.289 run (init,
// rate_limit_event) and the headless docs (api_retry); Pi's follow
// docs/json.md and rpc-commands.md, plus a recorded auto_retry_start.
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter, ClaudeTranslator, retryReason } from '../src/main/agents/claude'
import { PiAdapter, PiTranslator, shortError } from '../src/main/agents/pi'
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

function reduce(events: AgentEvent[], now = 1000) {
  const s = initialState()
  for (const e of events) applyEvent(s, e, now)
  return s
}

const notices = (events: AgentEvent[]) => events.flatMap((e) => (e.kind === 'notice' ? [e.text] : []))

describe('Claude: MCP and plugin health from init', () => {
  const t = new ClaudeTranslator()
  const events = t.handle({
    type: 'system',
    subtype: 'init',
    session_id: 's',
    mcp_servers: [
      { name: 'plugin:playwright:playwright', status: 'connected', source: 'plugin' },
      { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai' }
    ],
    mcp_server_errors: [{ name: 'broken', type: 'url_missing_type', message: 'url entry has no type' }],
    plugin_errors: [{ plugin: 'acme', type: 'load', message: 'missing path' }]
  })
  const s = reduce(events)

  it('lists every server, including ones skipped as invalid config', () => {
    expect(s.mcp).toEqual([
      { name: 'plugin:playwright:playwright', status: 'connected' },
      { name: 'claude.ai Gmail', status: 'needs-auth' },
      { name: 'broken', status: 'invalid', error: 'url entry has no type' }
    ])
  })

  it('says which plugins failed to load', () => {
    expect(notices(events)).toEqual(["Plugin acme didn't load: missing path"])
  })
})

describe('Claude: retries, compaction, limits and denials', () => {
  it('shows a pending retry until output arrives', () => {
    const t = new ClaudeTranslator()
    const s = reduce(
      t.handle({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'overloaded' })
    )
    expect(s.retry).toEqual({ attempt: 2, max: 10, at: 5000, reason: 'API overloaded (529)' })
    for (const e of t.handle({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }))
      applyEvent(s, e)
    expect(s.retry).toBeNull()
  })

  it('names unknown retry categories in plain words', () => {
    expect(retryReason('cloud_credential_error', null)).toBe('cloud credential error')
    expect(retryReason(undefined, undefined)).toBe('request failed')
  })

  it('marks a compaction in the transcript', () => {
    const t = new ClaudeTranslator()
    const s = reduce(t.handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 167000 } }))
    expect(s.transcripts.main.at(-1)).toMatchObject({
      type: 'notice',
      text: 'Context was full, so the conversation was compacted from 167k tokens.'
    })
  })

  it('warns once when a usage limit gets close, and again when it is reached', () => {
    const t = new ClaudeTranslator()
    const limit = (status: string) => ({
      type: 'rate_limit_event',
      rate_limit_info: { status, rateLimitType: 'five_hour', resetsAt: 1791156600 }
    })
    const events = [limit('allowed'), limit('allowed_warning'), limit('allowed_warning'), limit('rejected')].flatMap((r) => t.handle(r))
    const texts = notices(events)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toMatch(/^You're close to your five-hour usage limit\. It resets at /)
    expect(texts[1]).toMatch(/^You've reached your five-hour usage limit\./)
  })

  it('reports tools Claude refused without asking', () => {
    const t = new ClaudeTranslator()
    expect(notices(t.handle({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'Nobody can approve this.' }))).toEqual([
      'Bash was denied: Nobody can approve this.'
    ])
  })
})

class FakeClaude extends ClaudeAdapter {
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
}

describe('Claude: compact', () => {
  it('sends /compact as a prompt when idle', () => {
    const c = new FakeClaude()
    c.compact()
    expect(c.writes).toEqual([{ type: 'user', message: { role: 'user', content: '/compact' } }])
    expect(c.events.map((e) => e.kind)).toEqual(['notice', 'turn-start'])
  })

  it('waits for the turn to finish', () => {
    const c = new FakeClaude()
    c.send('work')
    c.writes = []
    c.compact()
    expect(c.writes).toEqual([])
    expect(notices(c.events)).toContain('Compact once the current turn finishes.')
  })
})

describe('Pi: retries and compaction', () => {
  it('keeps the provider message and status from a JSON error body', () => {
    const recorded =
      '429: {"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"metadata":{"headers":{}}}'
    expect(shortError(recorded)).toBe(
      'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day (429)'
    )
    expect(shortError('529 overloaded')).toBe('529 overloaded')
  })

  it('shows a retry, then clears it; a final failure says so', () => {
    const t = new PiTranslator(new Set())
    const s = reduce(t.handle({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded' }))
    expect(s.retry).toMatchObject({ attempt: 1, max: 3, at: 3000, reason: '529 overloaded' })
    const end = t.handle({ type: 'auto_retry_end', success: false, attempt: 3, finalError: '529 overloaded' })
    for (const e of end) applyEvent(s, e)
    expect(s.retry).toBeNull()
    expect(notices(end)).toEqual(['Gave up retrying: 529 overloaded'])
  })

  it('reports a compaction once, with the context it freed', () => {
    const t = new PiTranslator(new Set())
    const events = [
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', result: { summary: '…', tokensBefore: 150000, estimatedTokensAfter: 32000 }, aborted: false },
      { type: 'response', command: 'compact', success: true, data: { tokensBefore: 150000 } }
    ].flatMap((r) => t.handle(r))
    const s = reduce(events)
    expect(events.filter((e) => e.kind === 'compacted')).toHaveLength(1)
    expect(notices(events)).toEqual(['Compacting the conversation…'])
    expect(s.transcripts.main.at(-1)).toMatchObject({ text: 'Conversation compacted: 150k → 32k tokens.' })
    expect(s.stats.contextUsed).toBe(32000)
  })

  it('falls back to the compact response when no compaction events came', () => {
    const t = new PiTranslator(new Set())
    const events = t.handle({ type: 'response', command: 'compact', success: true, data: { tokensBefore: 90000, estimatedTokensAfter: 20000 } })
    expect(events).toEqual([{ kind: 'compacted', auto: false, tokensBefore: 90000, tokensAfter: 20000 }])
  })
})

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

const userStart = (text: string) => ({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } })

describe('Pi: follow-up messages', () => {
  function busyPi() {
    const p = new FakePi()
    p.send('first task')
    p.feed({ type: 'agent_start' })
    p.take()
    p.events.length = 0
    return p
  }

  it('queues a follow-up mid-turn and shows it when Pi delivers it', () => {
    const p = busyPi()
    p.send('then this', [], { followUp: true })
    expect(p.take()).toEqual([expect.objectContaining({ type: 'prompt', message: 'then this', streamingBehavior: 'followUp' })])
    const s = reduce(p.events)
    expect(s.queue).toEqual(['then this'])
    expect(s.transcripts.main).toEqual([])

    p.feed(userStart('then this'))
    for (const e of p.events.slice(-2)) applyEvent(s, e)
    expect(s.queue).toEqual([])
    expect(s.transcripts.main).toEqual([expect.objectContaining({ type: 'user', text: 'then this' })])
  })

  it('steers as before without the follow-up option', () => {
    const p = busyPi()
    p.send('change course')
    expect(p.take()).toEqual([expect.objectContaining({ streamingBehavior: 'steer' })])
  })

  it('sends a follow-up right away when Pi is idle', () => {
    const p = new FakePi()
    p.send('hello', [], { followUp: true })
    const [w] = p.take()
    expect(w).toMatchObject({ type: 'prompt', message: 'hello' })
    expect(w.streamingBehavior).toBeUndefined()
  })

  it('clears the queue', () => {
    const p = busyPi()
    p.send('a', [], { followUp: true })
    p.send('b', [], { followUp: true })
    p.take()
    p.clearQueue()
    expect(p.take()).toEqual([expect.objectContaining({ type: 'clear_queue' })])
    p.feed({ type: 'response', command: 'clear_queue', success: true, data: { steering: [], followUp: ['a', 'b'] } })
    const s = reduce(p.events)
    expect(s.queue).toEqual([])
    expect(notices(p.events)).toEqual(['Removed 2 queued messages.'])
  })

  it('says so when queued messages were dropped, e.g. by an interrupt', () => {
    const p = busyPi()
    p.send('later', [], { followUp: true })
    p.feed({ type: 'agent_settled' })
    expect(reduce(p.events).queue).toEqual([])
    expect(notices(p.events)).toEqual(['1 queued message was not sent.'])
  })
})

describe('Pi: compact and auto-compaction', () => {
  it('compacts over RPC when idle, and refreshes stats afterwards', () => {
    const p = new FakePi()
    p.compact()
    expect(p.take()).toEqual([expect.objectContaining({ type: 'compact' })])
    p.feed({ type: 'compaction_end', reason: 'manual', result: { tokensBefore: 1000, estimatedTokensAfter: 200 }, aborted: false })
    expect(p.take()).toEqual([expect.objectContaining({ type: 'get_session_stats' })])
  })

  it('turns auto-compaction off only when the setting says so', () => {
    const on = new FakePi()
    on.start({ agent: 'pi', cwd: '.' })
    expect(on.take().some((w) => w.type === 'set_auto_compaction')).toBe(false)
    const off = new FakePi({ ...settings, piAutoCompaction: false })
    off.start({ agent: 'pi', cwd: '.' })
    expect(off.take()).toContainEqual(expect.objectContaining({ type: 'set_auto_compaction', enabled: false }))
  })
})
