// pi-subagents runs in the background: the tool returns at once, the run's
// own events land in <asyncDir>/events.jsonl, and status arrives through
// widget snapshots and bg_wait completions. Fixtures are a real recording
// (pi 1.0.1 + pi-subagents 0.75.0, OpenRouter free router) in which the
// child run failed with an empty response.
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonlSplitter } from '../src/main/agents/jsonl'
import { PiAdapter, PiTranslator } from '../src/main/agents/pi'
import { PiRunTranslator, RunFollower, describeActivity, terminalStatus } from '../src/main/agents/pi-subagents'
import type { AgentEvent } from '../src/shared/events'
import { applyEvent, initialState } from '../src/shared/session'

function records(name: string): any[] {
  const out: any[] = []
  const sp = new JsonlSplitter((r) => out.push(r))
  sp.push(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
  sp.end()
  return out
}

const RUN_ID = 'd26f8a8c-22e6-4594-adde-e5c2fc0b2ef5'
const CALL_ID = 'call_78917a19387547ada49a54ba'

describe('pi-subagents: main session stream', () => {
  const t = new PiTranslator(new Set(['subagent']))
  const s = initialState()
  const events: AgentEvent[] = []
  let statusAfterToolReturned = ''
  let launched: ReturnType<PiTranslator['takeLaunchedRuns']> = []
  for (const rec of records('pi-subagents-main.jsonl')) {
    for (const e of t.handle(rec)) {
      events.push(e)
      applyEvent(s, e, 1000)
    }
    launched.push(...t.takeLaunchedRuns())
    if (rec.type === 'tool_execution_end' && rec.toolName === 'subagent') statusAfterToolReturned = s.subagents[CALL_ID]?.status
  }

  it('keeps the card running after the tool returns a background run id', () => {
    expect(statusAfterToolReturned).toBe('running')
    expect(launched).toEqual([{ subagentId: CALL_ID, runId: RUN_ID, asyncDir: expect.stringContaining(RUN_ID) }])
  })

  it('does not open a duplicate card for the run named in early snapshots', () => {
    expect(Object.keys(s.subagents)).toEqual([CALL_ID])
  })

  it('ends the card as failed, with the model and error from the completion', () => {
    const sub = s.subagents[CALL_ID]
    expect(sub).toMatchObject({ label: expect.stringContaining('List the files'), agentType: 'delegate', status: 'error' })
    expect(sub.model).toBe('openrouter/openrouter/free')
    const err = s.transcripts[CALL_ID].find((b) => b.type === 'assistant') as any
    expect(err.text).toContain('Subagent produced no output')
  })

  it('surfaces live activity from snapshots', () => {
    const activity = events.filter((e) => e.kind === 'subagent-update' && e.activity).map((e: any) => e.activity)
    expect(activity).toContain('▸ bash')
    expect(activity).toContain('Ended: failed')
  })
})

describe('pi-subagents: run events.jsonl', () => {
  const t = new PiRunTranslator(CALL_ID)
  const s = initialState()
  s.subagents[CALL_ID] = { id: CALL_ID, label: 'x', agentType: 'delegate', status: 'running', startedAt: 0, lastActivity: '', model: '' }
  for (const rec of records('pi-subagents-run.jsonl')) for (const e of t.handle(rec)) applyEvent(s, e, 1000)
  const transcript = s.transcripts[CALL_ID]

  it('opens with the task the subagent was given', () => {
    expect(transcript[0]).toMatchObject({ type: 'user', text: expect.stringContaining('List the files') })
    expect(s.busy).toBe(false) // a subagent's task must not mark the main session busy
  })

  it("shows the subagent's own tool calls and output", () => {
    expect(transcript.find((b) => b.type === 'tool')).toMatchObject({ name: 'bash', status: 'done', output: 'a.txt\nb.txt\n' })
  })

  it('reports the model that actually answered behind the router', () => {
    expect(s.subagents[CALL_ID].model).toBe('thinkingmachines/inkling:free')
  })

  it('shows the configured model only until an answering model is known', () => {
    const t2 = new PiRunTranslator('x')
    const end = (message: any) => t2.handle({ type: 'message_end', message: { role: 'assistant', content: [], ...message } })
    const models = (evs: AgentEvent[]) => evs.filter((e) => e.kind === 'subagent-update').map((e: any) => e.model)
    expect(models(end({ provider: 'openrouter', model: 'openrouter/free' }))).toEqual(['openrouter/openrouter/free'])
    expect(models(end({ provider: 'openrouter', model: 'openrouter/free', responseModel: 'a/one:free' }))).toEqual(['a/one:free'])
    expect(models(end({ provider: 'openrouter', model: 'openrouter/free' }))).toEqual([]) // no regression to the router id
    expect(models(end({ responseModel: 'b/two:free' }))).toEqual(['a/one:free, b/two:free'])
  })

  it('ends with the run status', () => {
    expect(s.subagents[CALL_ID].status).toBe('error')
  })
})

describe('pi-subagents management calls', () => {
  it('shows them as ordinary tool calls, not subagent cards', () => {
    const t = new PiTranslator(new Set(['subagent']))
    const s = initialState()
    const feed = (rec: any) => t.handle(rec).forEach((e) => applyEvent(s, e, 1000))
    feed({ type: 'tool_execution_start', toolCallId: 'g1', toolName: 'subagent', args: { action: 'guide', topic: 'agents' } })
    feed({ type: 'tool_execution_end', toolCallId: 'g1', toolName: 'subagent', result: { content: [{ type: 'text', text: '# Agents' }] } })
    feed({ type: 'tool_execution_start', toolCallId: 'r1', toolName: 'subagent', args: { action: 'resume', id: 'abcdef1234', message: 'go' } })
    expect(Object.keys(s.subagents)).toEqual(['r1'])
    expect(s.subagents['r1']).toMatchObject({ label: 'Resume abcdef12', agentType: 'resume' })
    expect(s.transcripts.main.find((b) => b.id === 'g1')).toMatchObject({ type: 'tool', status: 'done' })
  })
})

describe('pi-subagents helpers', () => {
  it('maps snapshot states', () => {
    expect(terminalStatus('complete')).toBe('done')
    expect(terminalStatus('failed')).toBe('error')
    expect(terminalStatus('partial')).toBe('error')
    expect(terminalStatus('running')).toBeNull()
    expect(terminalStatus('paused')).toBeNull()
  })

  it('describes activity from the busiest child step', () => {
    expect(describeActivity({ id: 'r', state: 'queued' })).toBe('Queued')
    expect(
      describeActivity({ id: 'r', state: 'running', children: [{ id: 's', state: 'running', activity: { currentTool: 'grep' } }] })
    ).toBe('▸ grep')
    expect(describeActivity({ id: 'r', state: 'running', activity: { turnCount: 2, toolCount: 1 } })).toBe('2 turns, 1 tool')
  })

  it('follows a growing events file, across split UTF-8, until the run completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-deck-follow-'))
    const file = join(dir, 'events.jsonl')
    writeFileSync(file, '')
    const seen: any[] = []
    const f = new RunFollower(dir, (r) => seen.push(r), file, 20)
    f.start()
    const tick = () => new Promise((r) => setTimeout(r, 80))

    const line = Buffer.from(JSON.stringify({ type: 'note', text: 'héllo ✓' }) + '\n')
    const cut = line.indexOf(Buffer.from('✓')) + 1 // split inside the 3-byte checkmark
    appendFileSync(file, line.subarray(0, cut))
    await tick()
    appendFileSync(file, line.subarray(cut))
    await tick()
    appendFileSync(file, JSON.stringify({ type: 'subagent.run.completed', status: 'complete' }) + '\n')
    await tick()
    appendFileSync(file, JSON.stringify({ type: 'after-stop' }) + '\n')
    await tick()
    f.stop()

    expect(seen.map((r) => r.type)).toEqual(['note', 'subagent.run.completed'])
    expect(seen[0].text).toBe('héllo ✓')
  })
})

// A real workflow run (two reviewer lanes) recorded from pi-subagents 0.75.0.
// The workflow's own file holds orchestration events; each lane is a run in a
// sibling folder with its own events.jsonl.
const WF_RUN = '6eb639c6-b393-44af-9593-589498a11b21'
const ARCH_RUN = 'f2b9c93a-0448-4598-b7c0-430e9dd2fdb9'

describe('pi-subagents: workflow runs', () => {
  it('gives each lane its own card and lists its run folder to follow', () => {
    const t = new PiRunTranslator('wf')
    const s = initialState()
    s.subagents['wf'] = { id: 'wf', label: 'Workflow', agentType: 'workflow', status: 'running', startedAt: 0, lastActivity: '', model: '' }
    const lanes: any[] = []
    for (const rec of records('pi-workflow-run.jsonl')) {
      for (const e of t.handle(rec)) applyEvent(s, e, 1000)
      lanes.push(...t.takeChildRuns())
    }
    expect(s.subagents['wf/arch']).toMatchObject({ label: 'Architecture review', agentType: 'reviewer', status: 'error' })
    expect(s.subagents['wf/build']).toMatchObject({ label: 'Build health review', agentType: 'reviewer', status: 'error' })
    expect(s.subagents['wf']).toMatchObject({ status: 'done', lastActivity: 'Finished' })
    expect(lanes.map((l) => l.runId)).toEqual([ARCH_RUN, '56e07036-0164-4a27-b069-8f0aed4367d0'])
    expect(lanes[0].asyncDir.replace(/\\/g, '/')).toMatch(new RegExp(`async-subagent-runs/${ARCH_RUN}$`))
  })

  it('labels workflow launches by script, not by the literal "true"', () => {
    const t = new PiTranslator(new Set(['subagent']))
    const s = initialState()
    const start = (id: string, args: any) =>
      t.handle({ type: 'tool_execution_start', toolCallId: id, toolName: 'subagent', args }).forEach((e) => applyEvent(s, e, 0))
    start('a', { workflow: 'true', async: true })
    start('b', { workflow: true })
    start('c', { workflow: '.\\workflows\\review.js' })
    expect([s.subagents.a.label, s.subagents.b.label, s.subagents.c.label]).toEqual(['Workflow', 'Workflow', 'review.js'])
  })

  it('follows a workflow end to end through the adapter, lanes included', async () => {
    // Lay the recordings out as pi-subagents does on disk.
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-wf-'))
    const wfDir = join(root, WF_RUN)
    const archDir = join(root, ARCH_RUN)
    mkdirSync(wfDir)
    mkdirSync(archDir)
    const wfLines = readFileSync(join(__dirname, 'fixtures', 'pi-workflow-run.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => {
        const r = JSON.parse(l)
        if (r.asyncDir) r.asyncDir = wfDir // recorded paths point at the original machine's temp dir
        return JSON.stringify(r)
      })
    writeFileSync(join(wfDir, 'events.jsonl'), wfLines.join('\n') + '\n')
    copyFileSync(join(__dirname, 'fixtures', 'pi-workflow-lane-arch.jsonl'), join(archDir, 'events.jsonl'))

    const s = initialState()
    const adapter = new PiAdapter((e) => applyEvent(s, e, 1000), {
      claudePath: 'claude',
      piPath: 'pi',
      permissionMode: 'acceptEdits',
      approvals: 'ask',
      piSubagentTools: ['subagent'],
      piAutoCompaction: true
    })
    applyEvent(s, { kind: 'subagent-start', subagentId: 'wf', label: 'Workflow', agentType: 'workflow' }, 0)
    ;(adapter as any).follow({ subagentId: 'wf', runId: WF_RUN, asyncDir: wfDir })
    await new Promise((r) => setTimeout(r, 1200))
    adapter.dispose()

    const arch = s.subagents['wf/arch']
    expect(arch.model).toContain('inkling') // the lane's own messages reached its card
    const transcript = s.transcripts['wf/arch']
    expect(transcript[0]).toMatchObject({ type: 'user' })
    expect(transcript.filter((b) => b.type === 'tool').length).toBeGreaterThan(5)
    expect(s.subagents['wf'].status).toBe('done')
  })
})
