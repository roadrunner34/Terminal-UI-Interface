// Support for the `pi-subagents` extension (npm: pi-subagents), whose runs
// are asynchronous by default. The `subagent` tool returns immediately with a
// run id and `asyncDir`; the run then:
//   - writes its own Pi event stream to `<asyncDir>/events.jsonl`, each
//     record tagged with subagentRunId / subagentStepIndex / subagentAgent;
//   - is summarized in `setWidget` UI requests whose lines carry
//     `PI_SUBAGENT_ASYNC_JSON:` + a status snapshot of every run;
//   - is reported in `details.completions[]` of tools like `bg_wait`.
import { open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentEvent, Scope } from '@shared/events'
import { JsonlSplitter } from './jsonl'

export const SNAPSHOT_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:'

export interface SnapshotRun {
  id: string
  label?: string
  kind?: string
  state: string
  activity?: { currentTool?: string; turnCount?: number; toolCount?: number }
  children?: SnapshotRun[]
}

/** Status snapshots from a `setWidget` request, or null for other requests. */
export function parseSnapshot(rec: any): SnapshotRun[] | null {
  if (rec.type !== 'extension_ui_request' || rec.method !== 'setWidget') return null
  if (!Array.isArray(rec.widgetLines)) return null
  const runs: SnapshotRun[] = []
  for (const line of rec.widgetLines) {
    if (typeof line !== 'string' || !line.startsWith(SNAPSHOT_PREFIX)) continue
    try {
      const snap = JSON.parse(line.slice(SNAPSHOT_PREFIX.length))
      if (Array.isArray(snap.runs)) runs.push(...snap.runs)
    } catch {
      // A truncated snapshot is skipped; the next one supersedes it.
    }
  }
  return runs.length ? runs : null
}

/** Snapshot states: queued | running | complete | failed | partial | paused | stopped | rejected. */
export function terminalStatus(state: string): 'done' | 'error' | null {
  if (state === 'complete' || state === 'completed') return 'done'
  if (['failed', 'partial', 'stopped', 'rejected', 'cancelled', 'aborted'].includes(state)) return 'error'
  return null
}

/** One-line card status for a running snapshot entry. */
export function describeActivity(run: SnapshotRun): string {
  if (run.state === 'queued') return 'Queued'
  if (run.state === 'paused') return 'Paused'
  const busy = run.children?.find((c) => c.state === 'running') ?? run
  const a = busy.activity ?? run.activity
  if (a?.currentTool) return `▸ ${a.currentTool}`
  if (a?.turnCount) return `${a.turnCount} turn${a.turnCount === 1 ? '' : 's'}, ${a.toolCount ?? 0} tool${a.toolCount === 1 ? '' : 's'}`
  return 'Working…'
}

/** A background run to follow: its card, run id and folder. */
export interface FollowTarget {
  subagentId: string
  runId: string
  asyncDir?: string
}

/** Events that end a run's file: a single run, or a whole workflow. */
const COMPLETION_EVENTS = new Set(['subagent.run.completed', 'subagent.workflow.completed'])

/**
 * Translates one run's events.jsonl into events scoped to its subagent card.
 * The file holds whole messages (no streaming deltas), so text arrives per
 * message rather than per token.
 *
 * A workflow run's file holds orchestration events instead: each lane
 * (`subagent.child-status`) is its own run with its own folder, and gets
 * its own card, listed by `takeChildRuns()` for the adapter to follow.
 */
export class PiRunTranslator {
  private seq = 0
  /** Models that actually answered (`responseModel`, e.g. behind a router). */
  private answered = new Set<string>()
  /** Configured provider/model, shown only until an answering model is known. */
  private configured = ''
  private shown = ''
  /** Workflow lanes: key → card id, and which are still running. */
  private lanes = new Map<string, string>()
  private runningLanes = new Set<string>()
  private childRuns: FollowTarget[] = []

  constructor(private subagentId: string) {}

  /** Workflow lanes discovered since the adapter last asked. */
  takeChildRuns(): FollowTarget[] {
    const runs = this.childRuns
    this.childRuns = []
    return runs
  }

  private laneSummary(): AgentEvent {
    const total = this.lanes.size
    const running = this.runningLanes.size
    const activity = running ? `${running} of ${total} lane${total === 1 ? '' : 's'} running` : `${total} lane${total === 1 ? '' : 's'} finished`
    return { kind: 'subagent-update', subagentId: this.subagentId, activity }
  }

  private noteModel(msg: any): AgentEvent[] {
    if (typeof msg.responseModel === 'string' && msg.responseModel) this.answered.add(msg.responseModel)
    else if (typeof msg.model === 'string' && msg.model && !this.configured)
      this.configured = msg.provider ? `${msg.provider}/${msg.model}` : msg.model
    const model = this.answered.size ? [...this.answered].join(', ') : this.configured
    if (!model || model === this.shown) return []
    this.shown = model
    return [{ kind: 'subagent-update', subagentId: this.subagentId, model }]
  }

  handle(rec: any): AgentEvent[] {
    const scope: Scope = { subagentId: this.subagentId }
    const out: AgentEvent[] = []
    switch (rec.type) {
      case 'message_end': {
        const msg = rec.message ?? {}
        if (msg.role === 'user') {
          const text = textOf(msg.content)
          if (text) out.push({ kind: 'user-message', scope, text })
        } else if (msg.role === 'assistant') {
          const messageId = `${this.subagentId}:${rec.subagentStepIndex ?? 0}:${++this.seq}`
          const thinking = blocksOf(msg.content, 'thinking', 'thinking')
          const text = blocksOf(msg.content, 'text', 'text')
          if (thinking) out.push({ kind: 'thinking-delta', scope, messageId, text: thinking })
          if (text.trim()) out.push({ kind: 'text', scope, messageId, text })
          out.push(...this.noteModel(msg))
        }
        break
      }
      case 'tool_execution_start':
        out.push({ kind: 'tool-start', scope, toolId: rec.toolCallId, name: rec.toolName, input: rec.args })
        break
      case 'tool_execution_update':
        out.push({ kind: 'tool-update', scope, toolId: rec.toolCallId, output: textOf(rec.partialResult?.content) })
        break
      case 'tool_execution_end':
        out.push({
          kind: 'tool-end',
          scope,
          toolId: rec.toolCallId,
          output: textOf(rec.result?.content),
          isError: !!rec.isError
        })
        break
      case 'auto_retry_start':
        out.push({ kind: 'subagent-update', subagentId: this.subagentId, activity: 'Retrying after a provider error' })
        break
      case 'subagent.child-status': {
        if (rec.status !== 'started' || !rec.childId || this.lanes.has(rec.childId)) break
        const laneId = `${this.subagentId}/${rec.childId}`
        this.lanes.set(rec.childId, laneId)
        this.runningLanes.add(rec.childId)
        out.push({ kind: 'subagent-start', subagentId: laneId, label: rec.label ?? rec.childId, agentType: rec.agent ?? 'subagent' })
        // Each lane runs in a sibling folder named after its own run id.
        if (rec.childRunId && typeof rec.asyncDir === 'string')
          this.childRuns.push({ subagentId: laneId, runId: rec.childRunId, asyncDir: join(dirname(rec.asyncDir), rec.childRunId) })
        out.push(this.laneSummary())
        break
      }
      case 'subagent.workflow.child_settled': {
        const laneId = this.lanes.get(rec.childKey)
        if (!laneId) break
        this.runningLanes.delete(rec.childKey)
        out.push({ kind: 'subagent-end', subagentId: laneId, status: terminalStatus(rec.outcome) ?? 'done' })
        out.push(this.laneSummary())
        break
      }
      case 'subagent.workflow.completed':
      case 'subagent.run.completed': {
        const status = terminalStatus(rec.status ?? rec.state) ?? 'done'
        out.push({ kind: 'subagent-update', subagentId: this.subagentId, activity: status === 'done' ? 'Finished' : `Ended: ${rec.status ?? rec.state}` })
        out.push({ kind: 'subagent-end', subagentId: this.subagentId, status })
        break
      }
    }
    return out
  }
}

function textOf(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('\n')
}

function blocksOf(content: any, type: string, field: string): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c: any) => c?.type === type && typeof c[field] === 'string')
    .map((c: any) => c[field])
    .join('\n\n')
}

/**
 * Follows a growing events.jsonl by polling (fs.watch is unreliable on
 * Windows) and stops once the run reports completion.
 */
export class RunFollower {
  private offset = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private reading = false
  private finished = false
  private splitter: JsonlSplitter
  private decoder = new StringDecoder('utf8')

  constructor(
    asyncDir: string,
    private onRecord: (rec: any) => void,
    private file = join(asyncDir, 'events.jsonl'),
    private intervalMs = 250
  ) {
    this.splitter = new JsonlSplitter((rec) => {
      if (COMPLETION_EVENTS.has(rec?.type)) this.finished = true
      this.onRecord(rec)
    })
  }

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.intervalMs)
    void this.poll()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async poll(): Promise<void> {
    if (this.reading || !this.timer) return
    this.reading = true
    try {
      const { size } = await stat(this.file)
      if (size > this.offset) {
        const fh = await open(this.file, 'r')
        try {
          const buf = Buffer.alloc(size - this.offset)
          const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset)
          this.offset += bytesRead
          // The decoder holds back a multi-byte character split across reads.
          this.splitter.push(this.decoder.write(buf.subarray(0, bytesRead)))
        } finally {
          await fh.close()
        }
      }
      if (this.finished) this.stop()
    } catch {
      // The file may not exist yet; try again on the next tick.
    } finally {
      this.reading = false
    }
  }
}
