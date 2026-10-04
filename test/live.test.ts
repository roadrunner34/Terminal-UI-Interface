// End-to-end checks against real agent CLIs. They cost tokens and need the
// agent installed and logged in, so they only run when asked:
//   PI_LIVE=1 npx vitest run test/live.test.ts
// PI_LIVE_MODEL picks the model (default: OpenRouter's free router).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PiAdapter } from '../src/main/agents/pi'
import type { AgentEvent } from '../src/shared/events'
import { applyEvent, initialState } from '../src/shared/session'

const settings = { claudePath: 'claude', piPath: 'pi', permissionMode: 'acceptEdits', approvals: 'ask' as const, piSubagentTools: ['subagent'] }

describe.runIf(process.env.PI_LIVE)('Pi live', () => {
  it('starts, switches model, runs a tool and reports stats', async () => {
    const s = initialState()
    const events: AgentEvent[] = []
    let settle!: () => void
    const settled = new Promise<void>((r) => (settle = r))
    let turns = 0

    const adapter = new PiAdapter((e) => {
      events.push(e)
      applyEvent(s, e)
      if (e.kind === 'turn-end') turns++
      // Stats arrive in the get_session_stats response after settling.
      if (e.kind === 'stats' && e.stats.inputTokens && turns > 0) settle()
    }, settings)

    const cwd = mkdtempSync(join(tmpdir(), 'agent-deck-live-'))
    adapter.start({ agent: 'pi', cwd, model: process.env.PI_LIVE_MODEL ?? 'openrouter/openrouter/free', effort: 'low' })
    adapter.send('Run the bash command `echo live-check`, then reply with one short sentence.')
    try {
      await settled
    } finally {
      adapter.dispose()
    }

    expect(events.find((e) => e.kind === 'error')).toBeUndefined()
    expect(s.models.length).toBeGreaterThan(0)
    expect(s.config.effort).toBe('low')
    expect(s.transcripts.main.find((b) => b.type === 'tool')).toMatchObject({ name: 'bash', status: 'done' })
    expect(s.stats.contextMax).toBeGreaterThan(0)
  }, 180_000)

  // Needs the pi-subagents extension installed.
  it.runIf(process.env.PI_LIVE_SUBAGENT)('follows a background subagent run to the end', async () => {
    const s = initialState()
    let done!: () => void
    const ended = new Promise<void>((r) => (done = r))
    // The model may make management calls first (e.g. `action: "guide"`);
    // wait for the delegate run's own card to finish.
    const adapter = new PiAdapter((e) => {
      applyEvent(s, e)
      if (e.kind === 'subagent-end' && s.subagents[e.subagentId]?.agentType === 'delegate') done()
    }, settings)

    const cwd = mkdtempSync(join(tmpdir(), 'agent-deck-live-sub-'))
    writeFileSync(join(cwd, 'notes.txt'), 'hello')
    adapter.start({ agent: 'pi', cwd, model: process.env.PI_LIVE_MODEL ?? 'openrouter/openrouter/free' })
    adapter.send(
      'You are authorized to delegate. Use the subagent tool to run the delegate agent with the task: ' +
        'list the files in the current directory and report their names. Then wait for its result and reply in one sentence.'
    )
    try {
      await ended
      await new Promise((r) => setTimeout(r, 1000)) // let the follower drain the run's file
    } finally {
      adapter.dispose()
    }

    // The model may launch other agents too; the delegate run must be there.
    const sub = Object.values(s.subagents).find((x) => x.agentType === 'delegate')!
    expect(sub).toBeDefined()
    expect(sub.model).not.toBe('')
    expect(sub.model).not.toContain('openrouter/openrouter/free') // the answering model, not the router id
    // The run's own events reached its transcript: at least the task it was given.
    expect(s.transcripts[sub.id][0]).toMatchObject({ type: 'user' })
    console.log('subagent', sub.status, sub.model, s.transcripts[sub.id].map((b) => b.type).join(','))
  }, 300_000)
})
