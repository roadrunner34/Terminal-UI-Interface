import { describe, expect, it } from 'vitest'
import { Notifier } from '../src/main/notify'
import type { AgentEvent } from '../src/shared/events'

function run(events: AgentEvent[], agent: 'claude' | 'pi' = 'claude') {
  const n = new Notifier(() => agent)
  return events.map((e) => n.handle(e)).filter(Boolean)
}

describe('Notifier', () => {
  it('says what finished, from the last line of the reply', () => {
    const notes = run([
      { kind: 'user-message', text: 'go' },
      { kind: 'text-delta', scope: 'main', messageId: 'm1', text: 'Thinking it over.' },
      { kind: 'text-delta', scope: 'main', messageId: 'm2', text: 'Done.\n\n**All 24 tests pass.**' },
      { kind: 'text-delta', scope: { subagentId: 's' }, messageId: 'x', text: 'subagent chatter' },
      { kind: 'turn-end' }
    ])
    expect(notes).toEqual([{ title: 'Claude Code finished', body: 'All 24 tests pass.', urgent: false }])
  })

  it('flags approvals and questions as urgent', () => {
    const notes = run(
      [
        { kind: 'prompt-request', id: 'a', scope: 'main', prompt: { type: 'tool-approval', tool: 'Bash', input: { command: 'rm -rf build' }, canAlways: false } },
        { kind: 'prompt-request', id: 'b', scope: 'main', prompt: { type: 'confirm', title: 'Clear session?' } }
      ],
      'pi'
    )
    expect(notes).toEqual([
      { title: 'Pi needs your approval', body: 'Bash: rm -rf build', urgent: true },
      { title: 'Pi needs your input', body: 'Clear session?', urgent: true }
    ])
  })

  it('reports a plan-mode turn as a plan to review', () => {
    const notes = run([{ kind: 'config', config: { mode: 'plan' } }, { kind: 'turn-end' }])
    expect(notes[0]).toMatchObject({ title: 'Claude Code: plan ready', urgent: true })
  })

  it('stays quiet for a clean exit and streaming noise', () => {
    expect(run([{ kind: 'exit', code: 0 }, { kind: 'stats', stats: {} }, { kind: 'turn-start' }])).toEqual([])
    expect(run([{ kind: 'exit', code: 3 }])[0]).toMatchObject({ title: 'Claude Code stopped' })
  })
})
