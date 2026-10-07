// End-to-end checks against real agent CLIs. They cost tokens and need the
// agent installed and logged in, so they only run when asked:
//   PI_LIVE=1 npx vitest run test/live.test.ts
// PI_LIVE_MODEL picks the model (default: OpenRouter's free router).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/main/agents/claude'
import { PiAdapter } from '../src/main/agents/pi'
import { listPiPackages, piPackageArgs, plainLine } from '../src/main/pi-packages'
import { run } from '../src/main/runner'
import type { AgentEvent } from '../src/shared/events'
import { applyEvent, initialState } from '../src/shared/session'

const settings = { claudePath: 'claude', piPath: 'pi', permissionMode: 'acceptEdits', approvals: 'ask' as const, piSubagentTools: ['subagent'], piAutoCompaction: true }

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

describe.runIf(process.env.PI_LIVE)('Pi packages live', () => {
  it('installs, lists and removes a package in a scratch agent dir', async () => {
    // A scratch agent dir, so the real ~/.pi is never touched.
    const agentDir = mkdtempSync(join(tmpdir(), 'agent-deck-live-pkgs-'))
    const env = { PI_CODING_AGENT_DIR: agentDir }
    const source = process.env.PI_LIVE_PACKAGE ?? 'npm:pi-plan'
    const exec = async (op: Parameters<typeof piPackageArgs>[0]) => {
      const built = piPackageArgs(op)
      if ('error' in built) throw new Error(built.error)
      const lines: string[] = []
      const r = await run('pi', built.args, { cwd: tmpdir(), env, timeoutMs: 180_000, onLine: (l) => lines.push(plainLine(l)) }).done
      return { ...r, lines }
    }

    const installed = await exec({ op: 'install', source })
    expect(installed.code).toBe(0)
    expect(installed.lines.join('\n')).toContain(`Installed ${source}`)
    const list = await listPiPackages(undefined, agentDir)
    expect(list).toEqual([expect.objectContaining({ source, scope: 'user', installed: true })])
    expect(list[0].version).toBeTruthy()

    const removed = await exec({ op: 'remove', source })
    expect(removed.code).toBe(0)
    expect(await listPiPackages(undefined, agentDir)).toEqual([])
  }, 400_000)
})

// Claude Code end to end: per-session flags and MCP status. Costs a little:
//   CLAUDE_LIVE=1 npx vitest run test/live.test.ts
describe.runIf(process.env.CLAUDE_LIVE)('Claude live', () => {
  const claudeSettings = { ...settings, approvals: 'deny' as const }

  async function session(advanced: Record<string, unknown>, prompt: string, until: (e: AgentEvent) => boolean) {
    const events: AgentEvent[] = []
    let settle!: () => void
    const settled = new Promise<void>((r) => (settle = r))
    const adapter = new ClaudeAdapter((e) => {
      events.push(e)
      if (until(e)) settle()
    }, claudeSettings)
    const cwd = mkdtempSync(join(tmpdir(), 'agent-deck-live-claude-'))
    adapter.start({ agent: 'claude', cwd, model: 'haiku', effort: 'low', advanced })
    adapter.send(prompt)
    try {
      await settled
    } finally {
      adapter.dispose()
    }
    return events
  }

  it('passes an appended prompt and a folder with spaces, and reports MCP status before the first turn', async () => {
    const extra = join(mkdtempSync(join(tmpdir(), 'agent-deck live dir ')), 'shared stuff')
    mkdirSync(extra)
    writeFileSync(join(extra, 'marker.txt'), 'BLUE-HERON-7')
    const events = await session(
      { appendSystemPrompt: 'When asked for the codeword, answer exactly PELICAN-42.', addDirs: [extra] },
      `What is the codeword? Then read ${join(extra, 'marker.txt')} and quote it. Reply on one line.`,
      (e) => e.kind === 'turn-end'
    )
    const text = events.flatMap((e) => (e.kind === 'text-delta' || e.kind === 'text' ? [e.text] : [])).join('')
    expect(events.find((e) => e.kind === 'error')).toBeUndefined()
    expect(text).toContain('PELICAN-42')
    expect(text).toContain('BLUE-HERON-7')
    expect(events.findIndex((e) => e.kind === 'mcp')).toBeLessThan(events.findIndex((e) => e.kind === 'session'))
  }, 180_000)

  it('stops at the budget with a notice', async () => {
    const events = await session({ maxBudgetUsd: 0.0001 }, 'Write a 400-word story about a lighthouse.', (e) => e.kind === 'turn-end')
    const notes = events.flatMap((e) => (e.kind === 'notice' ? [e.text] : []))
    console.log('budget notes', notes)
    expect(notes.some((n) => n.startsWith('Budget of $'))).toBe(true)
  }, 180_000)
})
