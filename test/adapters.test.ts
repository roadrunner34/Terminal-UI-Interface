import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeTranslator, claudeArgs } from '../src/main/agents/claude'
import { JsonlSplitter } from '../src/main/agents/jsonl'
import { PiTranslator, piArgs, PI_PLAN_TOOLS } from '../src/main/agents/pi'
import type { Translator } from '../src/main/agents/types'
import type { AgentEvent } from '../src/shared/events'
import { applyEvent, initialState } from '../src/shared/session'
import { shortModel } from '../src/shared/format'

function replay(name: string, t: Translator): AgentEvent[] {
  const events: AgentEvent[] = []
  const splitter = new JsonlSplitter((rec) => events.push(...t.handle(rec)))
  splitter.push(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
  splitter.end()
  return events
}

function reduce(events: AgentEvent[]) {
  const s = initialState()
  for (const e of events) applyEvent(s, e, 1000)
  return s
}

describe('JsonlSplitter', () => {
  it('handles records split across chunks and CRLF line endings', () => {
    const recs: any[] = []
    const bad: string[] = []
    const sp = new JsonlSplitter((r) => recs.push(r), (l) => bad.push(l))
    sp.push('{"a":1}\r\n{"b"')
    sp.push(':2}\n\nnot json\n{"c":3}')
    sp.end()
    expect(recs).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
    expect(bad).toEqual(['not json'])
  })
})

describe('Claude adapter', () => {
  const events = replay('claude-subagent.jsonl', new ClaudeTranslator())
  const s = reduce(events)

  it('reports the session', () => {
    expect(s.sessionId).toBe('sess-1')
    expect(s.model).toBe('claude-sonnet-5-5')
  })

  it('streams main text without duplicating the final assistant record', () => {
    const texts = s.transcripts.main.filter((b) => b.type === 'assistant').map((b) => (b as any).text)
    expect(texts).toEqual(["I'll launch a subagent.", 'There are two files.'])
  })

  it('tracks the subagent lifecycle and routes its messages to its transcript', () => {
    const sub = s.subagents['toolu_A']
    expect(sub).toMatchObject({ label: 'List files', agentType: 'general-purpose', status: 'done' })
    const sub_t = s.transcripts['toolu_A']
    expect(sub_t.map((b) => b.type)).toEqual(['tool', 'assistant'])
    expect(sub_t[0]).toMatchObject({ name: 'Bash', status: 'done', output: 'README.md\npackage.json' })
    // Subagent tool calls must not leak into the main transcript.
    expect(s.transcripts.main.some((b) => b.id === 'toolu_B')).toBe(false)
    expect(s.transcripts.main.find((b) => b.id === 'toolu_A')).toMatchObject({ status: 'done' })
  })

  it('shows the requested model alias, then the model the subagent actually ran on', () => {
    const updates = events.filter((e) => e.kind === 'subagent-update')
    expect(updates.map((e) => (e as any).model)).toEqual(['haiku', 'claude-haiku-4-5-20251001'])
    expect(s.subagents['toolu_A'].model).toBe('claude-haiku-4-5-20251001')
  })

  it('computes stats from usage and the result record', () => {
    expect(s.stats).toMatchObject({
      inputTokens: 12,
      outputTokens: 100,
      cacheRead: 25000,
      cacheWrite: 1200,
      contextMax: 200000,
      costUsd: 0.0421,
      // last main-scope assistant usage: 4 + 200 + 13000 + 8
      contextUsed: 13212
    })
    expect(s.busy).toBe(false)
  })
})

describe('Pi adapter (recorded from pi 1.0.1 over OpenRouter)', () => {
  const events = replay('pi-real.jsonl', new PiTranslator(new Set(['subagent'])))
  const s = reduce(events)

  it('picks up the model switch and thinking level', () => {
    expect(s.config).toEqual({ model: 'openrouter/openrouter/free', effort: 'low', mode: 'auto' })
    expect(s.model).toBe('openrouter/free')
    expect(s.models.map((m) => m.id)).toContain('openrouter/openrouter/free')
  })

  it('records the bash tool call with its output', () => {
    const tool = s.transcripts.main.find((b) => b.type === 'tool')
    expect(tool).toMatchObject({ name: 'bash', status: 'done', output: 'hello-from-pi\n' })
  })

  it('streams thinking and a final reply, then settles', () => {
    const replies = s.transcripts.main.filter((b) => b.type === 'assistant') as any[]
    expect(replies.some((b) => b.thinking.length > 0)).toBe(true)
    expect(replies.at(-1).text.trim().length).toBeGreaterThan(0)
    expect(s.busy).toBe(false)
  })

  it('reads totals and context usage from get_session_stats', () => {
    expect(s.stats).toMatchObject({ inputTokens: 3370, outputTokens: 110, costUsd: 0, contextUsed: 1643, contextMax: 200000 })
  })
})

describe('Claude CLI arguments', () => {
  const settings = { claudePath: 'claude', piPath: 'pi', permissionMode: 'acceptEdits', piSubagentTools: [] }

  it('omits model and effort flags when using defaults', () => {
    const args = claudeArgs(settings, { model: '', effort: '', mode: 'auto' })
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--effort')
    expect(args).toContain('--forward-subagent-text')
  })

  it('passes model, effort and resume id when switching mid-session', () => {
    const args = claudeArgs(settings, { model: 'opus', effort: 'xhigh', mode: 'auto' }, 'sess-1')
    expect(args.join(' ')).toContain('--model opus --effort xhigh --resume sess-1')
  })

  it('uses plan permission mode in plan mode and the configured one in auto', () => {
    const plan = claudeArgs(settings, { model: '', effort: '', mode: 'plan' }).join(' ')
    const auto = claudeArgs(settings, { model: '', effort: '', mode: 'auto' }).join(' ')
    expect(plan).toContain('--permission-mode plan')
    expect(auto).toContain('--permission-mode acceptEdits')
  })
})

describe('Claude plan mode', () => {
  it('follows the permission mode Claude reports', () => {
    const t = new ClaudeTranslator()
    const s = reduce([
      ...t.handle({ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'plan' }),
      ...t.handle({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' })
    ])
    expect(s.config.mode).toBe('plan')
    for (const e of t.handle({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' }))
      applyEvent(s, e)
    expect(s.config.mode).toBe('auto')
  })

  it('shows the plan from ExitPlanMode as text above the tool call', () => {
    const t = new ClaudeTranslator()
    const s = reduce(
      t.handle({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'ExitPlanMode', input: { plan: '1. Do it' } }] }
      })
    )
    expect(s.transcripts.main.map((b) => b.type)).toEqual(['assistant', 'tool'])
    expect(s.transcripts.main[0]).toMatchObject({ text: '1. Do it' })
  })
})

describe('Pi CLI arguments', () => {
  it('limits Pi to read-only tools in plan mode', () => {
    expect(piArgs('auto')).toEqual(['--mode', 'rpc'])
    expect(piArgs('plan')).toEqual(['--mode', 'rpc', '--tools', PI_PLAN_TOOLS])
    expect(PI_PLAN_TOOLS.split(',')).not.toContain('bash')
  })
})

describe('Pi adapter', () => {
  const events = replay('pi-subagent.jsonl', new PiTranslator(new Set(['subagent'])))
  const s = reduce(events)

  it('reports the session from get_state', () => {
    expect(s).toMatchObject({ agent: 'pi', sessionId: 'pi-sess', model: 'claude-sonnet-5-5' })
  })

  it('advertises models as provider/id and the thinking levels it supports', () => {
    expect(s.models).toEqual([
      { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'openai/gpt-5.5', label: 'GPT-5.5' }
    ])
    expect(s.efforts).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    expect(s.config).toEqual({ model: 'anthropic/claude-sonnet-5-5', effort: 'medium', mode: 'auto' })
  })

  it('streams assistant text', () => {
    expect(s.transcripts.main.find((b) => b.type === 'assistant')).toMatchObject({ text: 'Delegating now.' })
  })

  it('surfaces subagent tool executions as subagents', () => {
    expect(s.subagents['call_1']).toMatchObject({ label: 'Find all TODO comments', agentType: 'scout', status: 'done' })
    expect(s.transcripts['call_1'][0]).toMatchObject({ type: 'assistant', text: 'Found 3 TODOs' })
    expect(s.subagents['call_1'].model).toBe('anthropic/claude-haiku-4-5')
    expect(s.subagents['call_2']).toBeUndefined()
    expect(s.transcripts.main.find((b) => b.id === 'call_2')).toMatchObject({ name: 'bash', output: 'a.txt', status: 'done' })
  })

  it('lists every distinct model used by a parallel subagent run', () => {
    expect(s.subagents['call_3']).toMatchObject({ label: '2 parallel tasks', status: 'done' })
    expect(s.subagents['call_3'].model).toBe('openrouter/openrouter/free, anthropic/claude-sonnet-5-5')
  })

  it('takes cumulative stats from get_session_stats', () => {
    expect(s.stats).toMatchObject({
      inputTokens: 1800,
      outputTokens: 40,
      cacheRead: 200,
      costUsd: 0.0123,
      contextUsed: 1040,
      contextMax: 200000
    })
  })
})

describe('shortModel', () => {
  it('drops provider prefixes, the claude- family prefix and date stamps', () => {
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
    expect(shortModel('anthropic/claude-opus-5-5')).toBe('opus-5-5')
    expect(shortModel('openrouter/openrouter/free')).toBe('openrouter/free')
    expect(shortModel('openrouter/openrouter/free, anthropic/claude-sonnet-5-5')).toBe('openrouter/free, sonnet-5-5')
    expect(shortModel('haiku')).toBe('haiku')
    expect(shortModel('thinkingmachines/inkling:free, thinkingmachines/inkling-small:free')).toBe('inkling:free, inkling-small:free')
  })
})
