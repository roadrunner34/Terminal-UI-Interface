// Pi adapter: `pi --mode rpc`, JSONL commands on stdin, events on stdout.
// Field names follow pi-mono docs/rpc-commands.md and docs/json.md.
//
// Pi has no built-in subagents; they come from extensions that register a
// tool. Executions of any tool named in `subagentTools` become subagent cards.
//   - Foreground runs (e.g. the pi-mono `subagent` example) finish inside the
//     tool call; partial results are the subagent's transcript.
//   - Background runs (the `pi-subagents` package's default) return a run id
//     immediately; see pi-subagents.ts for how they are followed.
import { defaultConfig, type AgentConfig, type AgentEvent, type AgentMode, type StartOptions } from '@shared/events'
import { existsSync } from 'node:fs'
import { describeMode, PLAN_APPROVAL } from '@shared/format'
import { ProcessAdapter } from './process'
import {
  describeActivity,
  parseSnapshot,
  PiRunTranslator,
  RunFollower,
  terminalStatus,
  type FollowTarget,
  type SnapshotRun
} from './pi-subagents'
import type { AdapterSettings, Emit, Translator } from './types'

export class PiTranslator implements Translator {
  private msgSeq = 0
  private messageId = 'pi-0'
  private subagentModels = new Map<string, string>()
  /** Background run id → subagent card id. */
  private runs = new Map<string, string>()
  /** Last activity line per card, so snapshots only emit changes. */
  private activity = new Map<string, string>()
  /** Subagent tool calls that haven't returned yet. */
  private inFlight = new Set<string>()
  /** Background runs launched since the adapter last asked. */
  private launched: { subagentId: string; runId: string; asyncDir?: string }[] = []

  constructor(private subagentTools: Set<string>) {}

  /** Tie a run found elsewhere (e.g. a workflow lane) to its card, so snapshots match it. */
  registerRun(runId: string, subagentId: string) {
    this.runs.set(runId, subagentId)
  }

  /** Background runs the adapter should start following. */
  takeLaunchedRuns() {
    const runs = this.launched
    this.launched = []
    return runs
  }

  handle(rec: any): AgentEvent[] {
    const out: AgentEvent[] = []
    switch (rec.type) {
      case 'response':
        if (rec.success === false) out.push({ kind: 'error', message: rec.error ?? `${rec.command} failed` })
        else if (rec.command === 'get_state') out.push(...stateEvents(rec.data))
        else if (rec.command === 'get_session_stats') out.push({ kind: 'stats', stats: statsFrom(rec.data) })
        else if (rec.command === 'get_available_models') {
          const list = listFrom(rec.data, 'models')
          out.push({ kind: 'options', models: list.map((m: any) => ({ id: modelKey(m), label: m.name ?? m.id })) })
        } else if (rec.command === 'get_available_thinking_levels')
          out.push({ kind: 'options', efforts: listFrom(rec.data, 'levels') })
        break

      case 'thinking_level_changed':
        if (rec.level) out.push({ kind: 'config', config: { effort: rec.level } })
        break

      case 'agent_start':
        out.push({ kind: 'turn-start' })
        break

      case 'message_start':
        if (rec.message?.role === 'assistant') this.messageId = `pi-${++this.msgSeq}`
        break

      case 'message_update': {
        const ev = rec.assistantMessageEvent ?? {}
        if (ev.type === 'text_delta' && ev.delta)
          out.push({ kind: 'text-delta', scope: 'main', messageId: this.messageId, text: ev.delta })
        else if (ev.type === 'thinking_delta' && ev.delta)
          out.push({ kind: 'thinking-delta', scope: 'main', messageId: this.messageId, text: ev.delta })
        const u = rec.usage
        if (u) {
          const contextUsed = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0)
          if (contextUsed > 0) out.push({ kind: 'stats', stats: { contextUsed } })
        }
        break
      }

      case 'tool_execution_start': {
        const id: string = rec.toolCallId
        out.push({ kind: 'tool-start', scope: 'main', toolId: id, name: rec.toolName, input: rec.args })
        // Subagent tools may also take management calls (pi-subagents'
        // `action: "list"` etc.); only launches get a card.
        if (this.subagentTools.has(rec.toolName) && isLaunch(rec.args)) {
          this.inFlight.add(id)
          const { label, agentType } = describeSubagent(rec.args)
          out.push({ kind: 'subagent-start', subagentId: id, label, agentType })
        }
        break
      }

      case 'tool_execution_update': {
        const id: string = rec.toolCallId
        const text = contentText(rec.partialResult)
        out.push({ kind: 'tool-update', scope: 'main', toolId: id, output: text })
        if (this.inFlight.has(id)) {
          out.push({ kind: 'text', scope: { subagentId: id }, messageId: `${id}-out`, text })
          this.noteModels(id, rec.partialResult, out)
        }
        break
      }

      case 'tool_execution_end': {
        const id: string = rec.toolCallId
        const text = contentText(rec.result)
        const isError = !!rec.isError
        const details = rec.result?.details
        out.push({ kind: 'tool-end', scope: 'main', toolId: id, output: text, isError })
        if (this.inFlight.delete(id)) {
          const runId = details?.asyncId ?? (details?.asyncDir ? details.runId : undefined)
          if (runId && !isError) {
            // A background run: the tool returned, but the work has only started.
            this.runs.set(runId, id)
            this.launched.push({ subagentId: id, runId, asyncDir: details.asyncDir })
            out.push({ kind: 'subagent-update', subagentId: id, activity: 'Running in the background' })
          } else {
            out.push({ kind: 'text', scope: { subagentId: id }, messageId: `${id}-out`, text })
            this.noteModels(id, rec.result, out)
            out.push({ kind: 'subagent-end', subagentId: id, status: isError ? 'error' : 'done' })
          }
        }
        // bg_wait and friends report finished background runs.
        if (Array.isArray(details?.completions)) out.push(...this.completions(details.completions))
        break
      }

      case 'extension_ui_request': {
        const runs = parseSnapshot(rec)
        if (runs) out.push(...this.snapshot(runs))
        break
      }

      case 'agent_settled':
        out.push({ kind: 'turn-end' })
        break
    }
    return out
  }

  /** pi-subagents status snapshots: live activity and end state for every run. */
  private snapshot(runs: SnapshotRun[]): AgentEvent[] {
    const out: AgentEvent[] = []
    for (const run of runs) {
      let id = this.runs.get(run.id)
      // Snapshots can name a run before the launching tool call returns its
      // id; wait for that call rather than opening a duplicate card.
      if (!id && this.inFlight.size) continue
      if (!id) {
        // A run this session didn't launch through a visible tool call
        // (e.g. from a workflow); give it its own card.
        id = `run:${run.id}`
        this.runs.set(run.id, id)
        out.push({ kind: 'subagent-start', subagentId: id, label: run.label ?? 'Background run', agentType: run.kind ?? 'subagent' })
      }
      const ended = terminalStatus(run.state)
      const activity = ended ? (ended === 'done' ? 'Finished' : `Ended: ${run.state}`) : describeActivity(run)
      if (this.activity.get(id) !== activity) {
        this.activity.set(id, activity)
        out.push({ kind: 'subagent-update', subagentId: id, activity })
      }
      if (ended) out.push({ kind: 'subagent-end', subagentId: id, status: ended })
    }
    return out
  }

  /** `details.completions[]`: final state, model and any error for finished runs. */
  private completions(list: any[]): AgentEvent[] {
    const out: AgentEvent[] = []
    for (const c of list) {
      const id = this.runs.get(c?.runId)
      if (!id) continue
      this.noteModels(id, { details: { results: c.results } }, out)
      const errors = (Array.isArray(c.results) ? c.results : []).map((r: any) => r?.error).filter(Boolean)
      if (errors.length) out.push({ kind: 'text', scope: { subagentId: id }, messageId: `${id}-error`, text: `**Failed:** ${errors.join('\n\n')}` })
      const failed = c.success === false || terminalStatus(c.state) === 'error'
      out.push({ kind: 'subagent-end', subagentId: id, status: failed ? 'error' : 'done' })
    }
    return out
  }

  /**
   * The subagent extension reports each run's model in `details.results[]`.
   * Parallel and chain modes have several runs, possibly on different models.
   */
  private noteModels(id: string, result: any, out: AgentEvent[]) {
    const runs = result?.details?.results
    if (!Array.isArray(runs)) return
    const models = [...new Set(runs.map((r: any) => r?.model).filter((m: unknown) => typeof m === 'string' && m))]
    const model = models.join(', ')
    if (!model || this.subagentModels.get(id) === model) return
    this.subagentModels.set(id, model)
    out.push({ kind: 'subagent-update', subagentId: id, model })
  }
}

export function contentText(result: any): string {
  const content = result?.content
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('\n')
}

/** Launch calls name an agent, tasks, a chain or a workflow, or resume a run. */
export function isLaunch(args: any): boolean {
  if (!args || typeof args !== 'object') return true
  if (args.action) return args.action === 'resume'
  return true
}

export function describeSubagent(args: any): { label: string; agentType: string } {
  args ??= {}
  if (args.action === 'resume') return { label: `Resume ${String(args.id ?? 'run').slice(0, 8)}`, agentType: 'resume' }
  if (args.workflow) {
    // `true` (or "true") means a script in the reply; a string names a script file or resource.
    const named = typeof args.workflow === 'string' && args.workflow !== 'true'
    return { label: named ? args.workflow.split(/[\\/]/).pop()! : 'Workflow', agentType: 'workflow' }
  }
  if (Array.isArray(args.tasks)) return { label: `${args.tasks.length} parallel tasks`, agentType: 'parallel' }
  if (Array.isArray(args.chain)) return { label: `Chain of ${args.chain.length}`, agentType: 'chain' }
  const task: string = args.task ?? args.prompt ?? args.description ?? 'Subagent'
  return { label: task.slice(0, 60), agentType: args.agent ?? 'subagent' }
}

function stateEvents(data: any): AgentEvent[] {
  if (!data) return []
  const out: AgentEvent[] = [
    { kind: 'session', agent: 'pi', sessionId: data.sessionId ?? '', model: data.model?.id ?? data.model?.name ?? '' }
  ]
  const contextMax = data.model?.contextWindow ?? data.contextWindow
  if (contextMax) out.push({ kind: 'stats', stats: { contextMax } })
  const config: Partial<AgentConfig> = {}
  if (data.model) config.model = modelKey(data.model)
  if (data.thinkingLevel) config.effort = data.thinkingLevel
  out.push({ kind: 'config', config })
  return out
}

/** Pi models are addressed by provider + id, so the picker uses "provider/id". */
function modelKey(m: any): string {
  return m.provider ? `${m.provider}/${m.id}` : m.id
}

/** Responses may carry a bare array or wrap it (e.g. `{ models: [...] }`). */
function listFrom(data: any, field: string): any[] {
  if (Array.isArray(data)) return data
  return Array.isArray(data?.[field]) ? data[field] : []
}

function statsFrom(data: any) {
  const t = data?.tokens ?? {}
  const ctx = data?.contextUsage
  const cost = typeof data?.cost === 'number' ? data.cost : data?.cost?.total
  return {
    inputTokens: t.input,
    outputTokens: t.output,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    costUsd: cost,
    contextUsed: ctx?.tokens,
    contextMax: ctx?.contextWindow
  }
}

/**
 * Plan mode for Pi. With the `pi-plan` extension installed, Agent Deck drives
 * it: `/plan` toggles its read-only mode live, and its "what next?" dialog
 * becomes the approval step. Without it, plan mode relaunches Pi with only
 * read-only tools (no bash, edit, write or extension tools such as subagents)
 * and puts PI_PLAN_PREFIX before each prompt so it answers with a plan.
 */
export const PI_PLAN_TOOLS = 'read,grep,find,ls'
export const PI_PLAN_PREFIX =
  '[Plan mode: only read-only tools are available. Explore as needed, then reply with a numbered plan of the changes you would make. Do not try to change anything yet.]\n\n'

export function piArgs(mode: AgentMode): string[] {
  return mode === 'plan' ? ['--mode', 'rpc', '--tools', PI_PLAN_TOOLS] : ['--mode', 'rpc']
}

/** pi-plan's own states; `execute` is it carrying out an approved plan. */
type PlanExtMode = 'normal' | 'plan' | 'execute'

/** pi-plan's mode from its status line: "⏸ plan", "📋 2/5", or cleared. */
export function planStatusMode(text: unknown): PlanExtMode {
  if (typeof text !== 'string') return 'normal'
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
  if (/\bplan\b/i.test(plain)) return 'plan'
  return /\d+\/\d+/.test(plain) ? 'execute' : 'normal'
}

export function isPlanDialog(rec: any): boolean {
  return (
    rec?.type === 'extension_ui_request' &&
    rec.method === 'select' &&
    typeof rec.title === 'string' &&
    rec.title.startsWith('Plan mode') &&
    Array.isArray(rec.options)
  )
}

export class PiAdapter extends ProcessAdapter {
  private reqSeq = 0
  private cwd = ''
  private config: AgentConfig = defaultConfig()
  private busy = false
  /** A mode change requested mid-turn; applied when the turn ends. */
  private pendingMode: AgentMode | null = null
  /** The session's file, from get_state, so a relaunch can switch back to it. */
  private sessionFile = ''
  /** Whether pi-plan is installed; null until get_commands answers. */
  private planExt: boolean | null = null
  /** pi-plan's current state, from its session entries and status line. */
  private extMode: PlanExtMode = 'normal'
  /** Fallback only: the running process has read-only tools. */
  private readOnly = false
  /** pi-plan's open "what next?" dialog, held until the user decides. */
  private planDialog: { id: string; execute: string; stay: string } | null = null
  /** Prompts waiting for Pi to settle after a dialog is answered. */
  private queued: string[] = []
  /** Whether the last assistant turn said anything (failed turns don't). */
  private lastTurnHadText = false
  private pi: PiTranslator
  private followers = new Map<string, RunFollower>()
  /** Cards whose model came from their own run events. */
  private followedModels = new Set<string>()

  constructor(emit: Emit, private settings: AdapterSettings) {
    const pi = new PiTranslator(new Set(settings.piSubagentTools))
    super(emit, pi)
    this.pi = pi
  }

  /** Stream a background run's own events into its subagent card. */
  private follow(run: FollowTarget) {
    if (!run.asyncDir || this.followers.has(run.runId)) return
    this.pi.registerRun(run.runId, run.subagentId)
    const child = new PiRunTranslator(run.subagentId)
    const follower = new RunFollower(run.asyncDir, (rec) => {
      for (const e of child.handle(rec)) {
        if (e.kind === 'subagent-update' && e.model) this.followedModels.add(e.subagentId)
        this.emit(e)
      }
      // A workflow's lanes are runs of their own.
      for (const lane of child.takeChildRuns()) this.follow(lane)
    })
    this.followers.set(run.runId, follower)
    follower.start()
  }

  dispose(): void {
    for (const f of this.followers.values()) f.stop()
    this.followers.clear()
    super.dispose()
  }

  start(opts: StartOptions): void {
    this.cwd = opts.cwd
    this.config = { model: opts.model ?? '', effort: opts.effort ?? '', mode: opts.mode ?? 'auto' }
    this.sessionFile = opts.resume?.path ?? ''
    this.launch(false)
    this.command('get_available_models')
    this.apply({ model: opts.model, effort: opts.effort })
    this.command('get_session_stats')
    // Last, so its answer means everything above was handled; plan mode is
    // set up from there (see syncMode).
    this.command('get_commands')
    this.emit({ kind: 'config', config: { mode: this.config.mode } })
  }

  private launch(readOnly: boolean) {
    this.readOnly = readOnly
    this.spawn(this.settings.piPath, piArgs(readOnly ? 'plan' : 'auto'), this.cwd)
    // Over RPC rather than a CLI flag: session paths contain spaces and
    // backslashes, which the Windows shell guard in process.ts rejects.
    // A new session's file appears with its first message; before that there is nothing to return to.
    if (this.sessionFile && existsSync(this.sessionFile)) this.command('switch_session', { sessionPath: this.sessionFile })
  }

  /** Bring Pi in line with the chosen mode. Only called while Pi is idle. */
  private syncMode() {
    if (this.planExt === null) return
    const plan = this.config.mode === 'plan'
    if (this.planExt) {
      // `/plan` toggles; from `execute` it goes to plan.
      if (plan !== (this.extMode === 'plan')) {
        this.command('prompt', { message: '/plan' })
        this.extMode = plan ? 'plan' : 'normal'
      }
    } else if (plan !== this.readOnly) {
      // Tools are fixed at launch: relaunch on the same session.
      this.launch(plan)
      // The relaunched process starts from Pi's defaults; restore the choices.
      this.apply({ model: this.config.model, effort: this.config.effort })
    }
  }

  /**
   * Pi switches model and thinking level live over RPC. A mode change waits
   * for the current turn, so no work is cut off.
   */
  configure(change: Partial<AgentConfig>): void {
    const { mode, ...rest } = change
    if (rest.model || rest.effort) {
      this.apply(rest)
      const parts = [rest.model && `model ${rest.model}`, rest.effort && `${rest.effort} thinking`]
      this.emit({ kind: 'notice', text: `Switched to ${parts.filter(Boolean).join(' and ')}.` })
    }
    if (!mode || mode === (this.pendingMode ?? this.config.mode)) return
    this.pendingMode = mode
    // An open plan dialog holds the turn open; staying lets Pi settle.
    if (this.planDialog) this.answerPlanDialog('stay')
    else if (this.busy) this.emit({ kind: 'notice', text: 'The new mode applies when the current turn finishes.' })
    else this.applyMode()
  }

  private applyMode() {
    const mode = this.pendingMode
    this.pendingMode = null
    if (!mode || mode === this.config.mode) return
    this.config.mode = mode
    this.syncMode()
    this.emit({ kind: 'config', config: { mode } })
    this.emit({ kind: 'notice', text: describeMode(mode) })
  }

  /** pi-plan carries out the plan itself, tracking each step; otherwise ask in words. */
  approvePlan(): void {
    if (this.planDialog) {
      this.answerPlanDialog('execute')
      this.emit({ kind: 'notice', text: 'Running the plan.' })
      this.emit({ kind: 'turn-start' })
      return
    }
    this.configure({ mode: 'auto' })
    this.send(PLAN_APPROVAL)
  }

  private answerPlanDialog(choice: 'execute' | 'stay' | 'cancel') {
    const d = this.planDialog
    if (!d) return
    this.planDialog = null
    if (choice === 'cancel') this.write({ type: 'extension_ui_response', id: d.id, cancelled: true })
    else this.write({ type: 'extension_ui_response', id: d.id, value: choice === 'execute' ? d.execute : d.stay })
  }

  private apply(change: Partial<AgentConfig>): void {
    if (change.model) {
      const slash = change.model.indexOf('/')
      const [provider, modelId] =
        slash === -1 ? [undefined, change.model] : [change.model.slice(0, slash), change.model.slice(slash + 1)]
      this.command('set_model', { provider, modelId })
    }
    if (change.effort) this.command('set_thinking_level', { level: change.effort })
    // Thinking levels depend on the model; refresh both, then the live state.
    this.command('get_available_thinking_levels')
    this.command('get_state')
  }

  send(text: string): void {
    this.busy = true
    this.emit({ kind: 'user-message', text })
    // Without pi-plan, the plan instruction rides along with the prompt.
    const message = this.config.mode === 'plan' && !this.planExt ? PI_PLAN_PREFIX + text : text
    if (this.planDialog) {
      // A reply to the plan refines it: stay in plan mode, then send once Pi settles.
      this.answerPlanDialog('stay')
      this.queued.push(message)
    } else {
      this.command('prompt', { message })
    }
  }

  abort(): void {
    this.answerPlanDialog('cancel')
    this.command('abort')
  }

  protected onRecord(rec: any): void {
    if (rec.type === 'response' && rec.command === 'get_state' && rec.data?.sessionFile)
      this.sessionFile = rec.data.sessionFile
    if (rec.type === 'response' && rec.command === 'get_commands') {
      const names = listFrom(rec.data, 'commands').map((c: any) => c?.name)
      this.planExt = names.includes('plan') && names.includes('plan:status')
      if (!this.busy) this.syncMode()
    }
    if (this.onPlanRecord(rec)) return
    for (const e of this.pi.handle(rec)) {
      // Remember what Pi reports, so a relaunch can restore it.
      if (e.kind === 'config') {
        if (e.config.model) this.config.model = e.config.model
        if (e.config.effort) this.config.effort = e.config.effort
      }
      // A followed run already reported the model that actually answered
      // (e.g. behind a router); the completion's configured id is less precise.
      if (e.kind === 'subagent-update' && e.model && this.followedModels.has(e.subagentId)) {
        if (e.activity) this.emit({ ...e, model: undefined })
        continue
      }
      this.emit(e)
    }
    for (const run of this.pi.takeLaunchedRuns()) this.follow(run)
    if (rec.type === 'agent_start') this.busy = true
    // Pi reports cumulative usage on request; refresh once the agent is idle.
    if (rec.type === 'agent_settled') {
      this.busy = false
      this.command('get_session_stats')
      if (this.pendingMode) this.applyMode()
      const next = this.queued.shift()
      if (next) {
        this.busy = true
        this.command('prompt', { message: next })
      }
    }
  }

  /** pi-plan's records. Returns true when the record is fully handled here. */
  private onPlanRecord(rec: any): boolean {
    if (rec.type === 'turn_end' && rec.message?.role === 'assistant')
      this.lastTurnHadText = contentText(rec.message).trim().length > 0
    let ext: PlanExtMode | null = null
    if (rec.type === 'entry_appended' && rec.entry?.customType === 'pi-plan') ext = rec.entry.data?.mode ?? 'normal'
    if (rec.type === 'extension_ui_request' && rec.method === 'setStatus' && rec.statusKey === 'pi-plan')
      ext = planStatusMode(rec.statusText)
    if (ext) {
      this.extMode = ext
      // Before get_commands answers, Pi may restore a saved session's state;
      // the user's choice wins (syncMode). After that, follow pi-plan, e.g.
      // back to auto when it finishes executing a plan.
      const mode: AgentMode = ext === 'plan' ? 'plan' : 'auto'
      if (this.planExt && !this.pendingMode && mode !== this.config.mode) {
        this.config.mode = mode
        this.emit({ kind: 'config', config: { mode } })
      }
      return false
    }
    if (!isPlanDialog(rec)) return false
    const options: string[] = rec.options
    const execute = options.find((o) => o.startsWith('Execute')) ?? options[0]
    const stay = options.find((o) => o.startsWith('Stay')) ?? 'Stay in plan mode'
    this.planDialog = { id: rec.id, execute, stay }
    // A failed or empty turn has no plan to approve; let Pi retry or settle.
    if (!this.lastTurnHadText || this.queued.length || this.pendingMode) this.answerPlanDialog('stay')
    // Pi holds the turn open until the dialog is answered, but the plan is
    // ready, so the user is free to approve it or reply.
    else this.emit({ kind: 'turn-end' })
    return true
  }

  private command(type: string, extra: Record<string, unknown> = {}) {
    this.write({ id: `req-${++this.reqSeq}`, type, ...extra })
  }
}
