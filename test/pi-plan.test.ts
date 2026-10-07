// Plan mode for Pi: driving the pi-plan extension over RPC, and the
// read-only relaunch used when it isn't installed. Record shapes follow a
// live run of pi 1.0.2 with pi-plan 0.1.1.
import { describe, expect, it } from 'vitest'
import { PiAdapter, PI_PLAN_PREFIX, planStatusMode } from '../src/main/agents/pi'
import type { AgentEvent, AgentMode } from '../src/shared/events'

class FakePi extends PiAdapter {
  events: AgentEvent[] = []
  writes: any[] = []
  spawns: string[][] = []

  constructor() {
    const events: AgentEvent[] = []
    super((e) => events.push(e), { claudePath: 'claude', piPath: 'pi', permissionMode: 'acceptEdits', approvals: 'ask', piSubagentTools: [], piAutoCompaction: true })
    this.events = events
  }
  protected spawn(_command: string, args: string[]) {
    this.spawns.push(args)
  }
  protected write(obj: unknown) {
    this.writes.push(obj)
  }
  feed(...recs: any[]) {
    for (const r of recs) this.onRecord(r)
  }
  /** Writes since the last call. */
  take() {
    const w = this.writes
    this.writes = []
    return w
  }
  prompts() {
    return this.take().filter((w) => w.type === 'prompt').map((w) => w.message)
  }
  modes() {
    return this.events.flatMap((e) => (e.kind === 'config' && e.config.mode ? [e.config.mode] : []))
  }
}

const commands = (...names: string[]) => ({
  type: 'response',
  command: 'get_commands',
  success: true,
  data: { commands: names.map((name) => ({ name })) }
})
const withPlan = commands('subagents', 'plan', 'plan:status')
const planEntry = (mode: string) => ({ type: 'entry_appended', entry: { type: 'custom', customType: 'pi-plan', data: { mode, steps: [] } } })
const turnEnd = (text: string) => ({
  type: 'turn_end',
  message: { role: 'assistant', content: text ? [{ type: 'text', text }] : [] }
})
const dialog = {
  type: 'extension_ui_request',
  id: 'dlg-1',
  method: 'select',
  title: 'Plan mode — what next?',
  options: ['Execute the plan', 'Stay in plan mode', 'Refine the plan']
}

function started(mode: AgentMode, cmds = withPlan) {
  const pi = new FakePi()
  pi.start({ agent: 'pi', cwd: 'D:\\proj', mode })
  pi.take()
  pi.feed(cmds)
  return pi
}

/** A plan-mode session whose last turn ended with a plan and the dialog open. */
function planReady() {
  const pi = started('plan')
  pi.feed(planEntry('plan'))
  pi.send('Plan the refactor')
  pi.feed({ type: 'agent_start' }, turnEnd('Plan:\n1. Read the code\n2. Change it'), dialog)
  pi.take()
  return pi
}

describe('Pi plan mode with pi-plan', () => {
  it('turns pi-plan on with /plan once it is detected', () => {
    const pi = started('plan')
    expect(pi.prompts()).toEqual(['/plan'])
    expect(pi.spawns).toEqual([['--mode', 'rpc']])
  })

  it('leaves pi-plan alone in auto mode', () => {
    expect(started('auto').prompts()).toEqual([])
  })

  it("overrides a saved session's plan state with the chosen mode", () => {
    const pi = new FakePi()
    pi.start({ agent: 'pi', cwd: 'D:\\proj', mode: 'auto', resume: { id: 's', path: 'missing.jsonl' } })
    // pi-plan restores plan mode on session start, before get_commands answers.
    pi.feed({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'pi-plan', statusText: '\u001b[38;5;3m⏸ plan\u001b[39m' })
    pi.take()
    pi.feed(withPlan)
    expect(pi.prompts()).toEqual(['/plan'])
    expect(pi.modes()).toEqual(['auto'])
  })

  it('sends prompts as typed, since pi-plan injects its own instructions', () => {
    const pi = started('plan')
    pi.take()
    pi.send('Plan it')
    expect(pi.prompts()).toEqual(['Plan it'])
  })

  it('holds the "what next?" dialog and ends the turn so the plan can be approved', () => {
    const pi = planReady()
    expect(pi.writes).toEqual([])
    expect(pi.events.at(-1)).toEqual({ kind: 'turn-end' })
  })

  it('approving answers the dialog with Execute, so pi-plan runs and tracks the plan', () => {
    const pi = planReady()
    pi.approvePlan()
    expect(pi.take()).toEqual([{ type: 'extension_ui_response', id: 'dlg-1', value: 'Execute the plan' }])
    expect(pi.events.at(-1)).toEqual({ kind: 'turn-start' })
    // pi-plan reports execute mode, which the toggle shows as auto.
    pi.feed(planEntry('execute'))
    expect(pi.modes().at(-1)).toBe('auto')
  })

  it('a reply refines the plan: stay in plan mode, then send once Pi settles', () => {
    const pi = planReady()
    pi.send('Also update the tests')
    expect(pi.take()).toEqual([{ type: 'extension_ui_response', id: 'dlg-1', value: 'Stay in plan mode' }])
    pi.feed({ type: 'agent_end' }, { type: 'agent_settled' })
    expect(pi.prompts()).toEqual(['Also update the tests'])
  })

  it('switching to auto with the dialog open stays, then turns plan mode off', () => {
    const pi = planReady()
    pi.configure({ mode: 'auto' })
    expect(pi.take()).toEqual([{ type: 'extension_ui_response', id: 'dlg-1', value: 'Stay in plan mode' }])
    pi.feed({ type: 'agent_settled' })
    expect(pi.prompts()).toEqual(['/plan'])
  })

  it('answers the dialog at once after a failed turn, so Pi can retry', () => {
    const pi = started('plan')
    pi.feed(planEntry('plan'))
    pi.take()
    pi.feed({ type: 'agent_start' }, turnEnd(''), dialog)
    expect(pi.take()).toEqual([{ type: 'extension_ui_response', id: 'dlg-1', value: 'Stay in plan mode' }])
  })

  it('interrupting cancels an open dialog', () => {
    const pi = planReady()
    pi.abort()
    expect(pi.take()).toEqual([{ type: 'extension_ui_response', id: 'dlg-1', cancelled: true }, expect.objectContaining({ type: 'abort' })])
  })

  it('follows pi-plan back to auto when it finishes a plan', () => {
    const pi = started('plan')
    pi.feed(planEntry('plan'), planEntry('execute'), planEntry('normal'))
    expect(pi.modes()).toEqual(['plan', 'auto'])
  })
})

describe('Pi plan mode without pi-plan', () => {
  it('relaunches with read-only tools and prefixes prompts', () => {
    const pi = started('plan', commands('subagents'))
    expect(pi.spawns.at(-1)).toEqual(['--mode', 'rpc', '--tools', 'read,grep,find,ls', '--no-mcp'])
    pi.take()
    pi.send('Plan it')
    expect(pi.prompts()).toEqual([PI_PLAN_PREFIX + 'Plan it'])
  })

  it('approving relaunches with full tools and asks in words', () => {
    const pi = started('plan', commands('subagents'))
    pi.take()
    pi.approvePlan()
    expect(pi.spawns.at(-1)).toEqual(['--mode', 'rpc'])
    expect(pi.prompts()).toEqual(['The plan is approved. Go ahead and implement it.'])
  })
})

describe('planStatusMode', () => {
  it("reads pi-plan's status line", () => {
    expect(planStatusMode('\u001b[38;5;3m⏸ plan\u001b[39m')).toBe('plan')
    expect(planStatusMode('📋 2/5')).toBe('execute')
    expect(planStatusMode(undefined)).toBe('normal')
  })
})
