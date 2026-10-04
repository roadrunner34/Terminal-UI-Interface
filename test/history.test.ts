import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listClaude, loadClaude, promptText } from '../src/main/history/claude'
import { listPi, piProjectName, replayPi } from '../src/main/history/pi'
import { readRecords } from '../src/main/history/files'
import type { HistoryEvent } from '../src/shared/api'
import { formatWhen } from '../src/shared/format'
import { applyEvent, initialState } from '../src/shared/session'

const root = join(__dirname, 'fixtures', 'history')
const cwd = 'D:\\proj'

function reduce(events: HistoryEvent[]) {
  const s = initialState()
  for (const { at, event } of events) applyEvent(s, event, at)
  return s
}

describe('Claude history', () => {
  it('lists sessions with a prompt, titled by the readable ai-title', async () => {
    const list = await listClaude(cwd, join(root, 'claude'))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      agent: 'claude',
      id: 'sess-1',
      cwd,
      title: 'Repo review with a subagent',
      startedAt: Date.parse('2026-10-01T10:00:01.000Z')
    })
  })

  it('ignores folders for other projects', async () => {
    expect(await listClaude('D:\\other', join(root, 'claude'))).toEqual([])
  })

  it('reads typed prompts and slash commands, not injected text', () => {
    expect(promptText({ message: { content: 'hello' } })).toBe('hello')
    expect(promptText({ isMeta: true, message: { content: 'hidden' } })).toBe('')
    expect(promptText({ message: { content: '<task-notification>x</task-notification>' } })).toBe('')
    expect(promptText({ message: { content: '<command-name>/model</command-name><command-args>opus</command-args>' } })).toBe(
      '/model opus'
    )
    expect(promptText({ message: { content: [{ type: 'tool_result', content: 'x' }] } })).toBe('')
  })

  it('replays the main transcript and a background subagent into its card', async () => {
    const s = reduce(await loadClaude(join(root, 'claude', 'projects', 'D--proj', 'sess-1.jsonl')))
    expect(s.busy).toBe(false)
    expect(s.running).toBe(false)
    expect(s.stats.contextUsed).toBe(1015)

    const main = s.transcripts.main
    expect(main.map((b) => b.type)).toEqual(['user', 'user', 'assistant', 'tool', 'assistant'])
    expect(main[0]).toMatchObject({ type: 'user', text: '/clear' })
    expect(main[2]).toMatchObject({ type: 'assistant', text: 'Sending a reviewer.' })
    expect(main[3]).toMatchObject({ type: 'tool', name: 'Agent', status: 'done' })

    const sub = s.subagents.toolu_sub
    expect(sub).toMatchObject({ label: 'Review code', agentType: 'Explore', status: 'done', model: 'claude-haiku-4-5' })
    // Starts at the Agent call; ends at its last reply, not the tool's
    // immediate return or the much later follow-up message.
    expect(sub.startedAt).toBe(Date.parse('2026-10-01T10:00:06.000Z'))
    expect(sub.endedAt).toBe(Date.parse('2026-10-01T10:04:00.000Z'))

    const t = s.transcripts.toolu_sub
    expect(t.map((b) => b.type)).toEqual(['user', 'tool', 'assistant', 'user'])
    expect(t[1]).toMatchObject({ type: 'tool', name: 'Read', output: 'file body', status: 'done' })
    expect(t[2]).toMatchObject({ type: 'assistant', text: 'Looks fine.' })
  })
})

describe('Pi history', () => {
  it('encodes folders the way Pi does', () => {
    expect(piProjectName('D:\\Terminal UI Interface')).toBe('--D--Terminal UI Interface--')
    expect(piProjectName('D:\\')).toBe('--D----')
    expect(piProjectName('/home/me/proj')).toBe('--home-me-proj--')
  })

  it('lists sessions for this folder only, titled by session name', async () => {
    const list = await listPi(cwd, join(root, 'pi'))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      agent: 'pi',
      id: 'pi-1',
      title: 'Test investigation',
      startedAt: Date.parse('2026-10-02T09:00:00.000Z')
    })
  })

  it('replays messages, tools and subagent cards', async () => {
    const recs = await readRecords(join(root, 'pi', '--D--proj--', '2026-10-02T09-00-00-000Z_pi-1.jsonl'))
    const s = reduce(replayPi(recs, new Set(['subagent'])))
    expect(s.busy).toBe(false)
    expect(s.stats.contextUsed).toBe(120)

    const main = s.transcripts.main
    expect(main.map((b) => b.type)).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(main[1]).toMatchObject({ text: 'Starting a subagent.', thinking: 'Delegate.' })
    expect(main[3]).toMatchObject({ name: 'bash', output: 'a b', status: 'error' })

    expect(s.subagents.call_sub).toMatchObject({ label: 'Read the tests', agentType: 'scout', status: 'done' })
    expect(s.subagents.call_sub.endedAt! - s.subagents.call_sub.startedAt).toBe(28_000)
    expect(s.transcripts.call_sub).toMatchObject([{ type: 'assistant', text: 'Tests look solid.' }])
  })
})

describe('formatWhen', () => {
  const now = new Date(2026, 9, 3, 15, 0).getTime()
  it('reads as a short relative time', () => {
    expect(formatWhen(now - 20_000, now)).toBe('just now')
    expect(formatWhen(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatWhen(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(formatWhen(new Date(2026, 9, 2, 23, 0).getTime(), now)).toBe('Yesterday')
    expect(formatWhen(new Date(2026, 8, 20, 9, 0).getTime(), now)).not.toMatch(/ago|Yesterday/)
  })
})
