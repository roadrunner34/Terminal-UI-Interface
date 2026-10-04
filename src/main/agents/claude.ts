// Claude Code adapter: `claude -p` with stream-json in both directions.
//
// Subagents: when the model calls the Task/Agent tool, every later message
// produced by that subagent carries `parent_tool_use_id` = that tool_use id.
// We use the tool_use id as the subagent id and route those messages to it.
import {
  defaultConfig,
  type AgentConfig,
  type AgentEvent,
  type AgentMode,
  type ImageAttachment,
  type McpServer,
  type ModelOption,
  type PromptAnswer,
  type PromptQuestion,
  type Scope,
  type StartOptions,
  type UserPrompt
} from '@shared/events'
import { describeMode, PLAN_APPROVAL } from '@shared/format'
import { ProcessAdapter } from './process'
import type { AdapterSettings, Emit, Translator } from './types'

const SUBAGENT_TOOLS = new Set(['Task', 'Agent'])

export class ClaudeTranslator implements Translator {
  /** Message ids that received streaming deltas, so full records don't duplicate text. */
  private streamed = new Set<string>()
  /** Current streaming message id per scope key. */
  private current = new Map<string, string>()
  private subagents = new Set<string>()
  /** Last model reported per subagent, so updates fire only on change. */
  private subagentModels = new Map<string, string>()
  /** Scope of each tool call, so a permission request lands where its tool runs. */
  private toolScopes = new Map<string, Scope>()
  /** Last usage-limit status, so a warning shows once rather than every turn. */
  private limitStatus = 'allowed'

  handle(rec: any): AgentEvent[] {
    const out: AgentEvent[] = []
    const scope = this.scopeOf(rec.parent_tool_use_id)
    const key = scope === 'main' ? 'main' : scope.subagentId

    switch (rec.type) {
      case 'system':
        if (rec.subtype === 'init')
          out.push({ kind: 'session', agent: 'claude', sessionId: rec.session_id ?? '', model: rec.model ?? '' })
        // Claude reports its permission mode on init and whenever it changes,
        // including when it leaves plan mode by itself.
        if ((rec.subtype === 'init' || rec.subtype === 'status') && typeof rec.permissionMode === 'string')
          out.push({ kind: 'config', config: { mode: modeOf(rec.permissionMode) } })
        // init names the commands; commands_changed follows with descriptions.
        if (rec.subtype === 'init' && Array.isArray(rec.slash_commands))
          out.push({ kind: 'commands', commands: rec.slash_commands.filter((n: unknown) => typeof n === 'string').map((name: string) => ({ name })) })
        if (rec.subtype === 'commands_changed' && Array.isArray(rec.commands))
          out.push({
            kind: 'commands',
            commands: rec.commands
              .filter((c: any) => typeof c?.name === 'string')
              .map((c: any) => ({ name: c.name, description: typeof c.description === 'string' ? c.description : undefined }))
          })
        if (rec.subtype === 'init') out.push(...initHealth(rec))
        if (rec.subtype === 'api_retry')
          out.push({
            kind: 'retry',
            attempt: rec.attempt ?? 1,
            max: rec.max_retries ?? 0,
            delayMs: rec.retry_delay_ms ?? 0,
            reason: retryReason(rec.error, rec.error_status)
          })
        if (rec.subtype === 'compact_boundary') {
          const meta = rec.compact_metadata ?? {}
          out.push({ kind: 'compacted', auto: meta.trigger === 'auto', tokensBefore: meta.pre_tokens || undefined })
        }
        if (rec.subtype === 'permission_denied') {
          const tool = rec.tool_name ?? rec.display_name ?? 'A tool call'
          const why = rec.message ?? rec.reason
          out.push({ kind: 'notice', text: `${tool} was denied${why ? `: ${why}` : '.'}` })
        }
        break

      case 'rate_limit_event': {
        const info = rec.rate_limit_info ?? {}
        const status = typeof info.status === 'string' ? info.status : 'allowed'
        if (status !== this.limitStatus && status !== 'allowed') out.push({ kind: 'notice', text: limitText(status, info) })
        this.limitStatus = status
        break
      }

      case 'stream_event': {
        const ev = rec.event ?? {}
        if (ev.type === 'message_start' && ev.message?.id) this.current.set(key, ev.message.id)
        if (ev.type === 'message_start') this.noteModel(scope, ev.message?.model, out)
        if (ev.type === 'content_block_delta') {
          const messageId = this.current.get(key) ?? 'stream'
          const d = ev.delta ?? {}
          if (d.type === 'text_delta' && d.text) {
            this.streamed.add(messageId)
            out.push({ kind: 'text-delta', scope, messageId, text: d.text })
          } else if (d.type === 'thinking_delta' && d.thinking) {
            this.streamed.add(messageId)
            out.push({ kind: 'thinking-delta', scope, messageId, text: d.thinking })
          }
        }
        break
      }

      case 'assistant': {
        const msg = rec.message ?? {}
        const messageId: string = msg.id ?? rec.uuid ?? 'msg'
        // A subagent's own messages report the model actually serving it.
        this.noteModel(scope, msg.model, out)
        for (const block of msg.content ?? []) {
          if (block.type === 'text' && !this.streamed.has(messageId)) {
            out.push({ kind: 'text-delta', scope, messageId, text: block.text ?? '' })
          } else if (block.type === 'thinking' && !this.streamed.has(messageId)) {
            out.push({ kind: 'thinking-delta', scope, messageId, text: block.thinking ?? '' })
          } else if (block.type === 'tool_use') {
            // The finished plan arrives as this tool's input; show it as text, not JSON.
            if (block.name === 'ExitPlanMode' && typeof block.input?.plan === 'string')
              out.push({ kind: 'text', scope, messageId: `${block.id}-plan`, text: block.input.plan })
            out.push({ kind: 'tool-start', scope, toolId: block.id, name: block.name, input: block.input })
            this.toolScopes.set(block.id, scope)
            if (SUBAGENT_TOOLS.has(block.name)) {
              this.subagents.add(block.id)
              const input = block.input ?? {}
              out.push({
                kind: 'subagent-start',
                subagentId: block.id,
                label: input.description ?? input.prompt?.slice(0, 60) ?? 'Subagent',
                agentType: input.subagent_type ?? 'general-purpose'
              })
              // The Agent tool may request a model alias; refined once it replies.
              this.noteModel({ subagentId: block.id }, input.model, out)
            }
          }
        }
        const u = msg.usage
        if (u && scope === 'main') {
          const contextUsed =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.output_tokens ?? 0)
          if (contextUsed > 0) out.push({ kind: 'stats', stats: { contextUsed } })
        }
        break
      }

      case 'user': {
        const content = rec.message?.content
        if (!Array.isArray(content)) break
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          const isError = !!block.is_error
          out.push({ kind: 'tool-end', scope, toolId: block.tool_use_id, output: resultText(block.content), isError })
          if (this.subagents.has(block.tool_use_id)) {
            this.subagents.delete(block.tool_use_id)
            out.push({ kind: 'subagent-end', subagentId: block.tool_use_id, status: isError ? 'error' : 'done' })
          }
        }
        break
      }

      // With --permission-prompt-tool stdio, Claude asks before tools that need
      // approval and waits for a control_response (see ClaudeAdapter.answerPrompt).
      case 'control_request': {
        const req = rec.request ?? {}
        if (req.subtype !== 'can_use_tool') break
        const prompt = promptFor(req)
        if (prompt)
          out.push({ kind: 'prompt-request', id: rec.request_id, scope: this.toolScopes.get(req.tool_use_id) ?? 'main', prompt })
        break
      }

      case 'control_cancel_request':
        if (rec.request_id) out.push({ kind: 'prompt-resolved', id: rec.request_id })
        break

      case 'result': {
        // Claude's subagents run inside the turn, so any still open now were interrupted.
        for (const id of this.subagents) {
          out.push({ kind: 'subagent-update', subagentId: id, activity: 'Interrupted' })
          out.push({ kind: 'subagent-end', subagentId: id, status: 'error' })
        }
        this.subagents.clear()
        out.push({ kind: 'stats', stats: resultStats(rec) })
        if (rec.is_error && rec.subtype !== 'success')
          out.push({ kind: 'error', message: rec.result ?? rec.subtype ?? 'Agent error' })
        out.push({ kind: 'turn-end' })
        break
      }
    }
    return out
  }

  private noteModel(scope: Scope, model: unknown, out: AgentEvent[]) {
    if (scope === 'main' || typeof model !== 'string' || !model) return
    const id = scope.subagentId
    if (!this.subagents.has(id) || this.subagentModels.get(id) === model) return
    this.subagentModels.set(id, model)
    out.push({ kind: 'subagent-update', subagentId: id, model })
  }

  private scopeOf(parent: string | null | undefined): Scope {
    return parent ? { subagentId: parent } : 'main'
  }
}

/** MCP server status and plugin load errors from the init record. */
function initHealth(rec: any): AgentEvent[] {
  const out: AgentEvent[] = []
  const servers: McpServer[] = (Array.isArray(rec.mcp_servers) ? rec.mcp_servers : [])
    .filter((m: any) => typeof m?.name === 'string')
    .map((m: any) => ({ name: m.name, status: String(m.status ?? 'unknown') }))
  // Entries Claude skipped as invalid config never appear in mcp_servers.
  for (const e of Array.isArray(rec.mcp_server_errors) ? rec.mcp_server_errors : [])
    if (typeof e?.name === 'string') servers.push({ name: e.name, status: 'invalid', error: e.message })
  if (servers.length || Array.isArray(rec.mcp_servers)) out.push({ kind: 'mcp', servers })
  for (const e of Array.isArray(rec.plugin_errors) ? rec.plugin_errors : [])
    out.push({ kind: 'notice', text: `Plugin ${e?.plugin ?? ''} didn't load: ${e?.message ?? e?.type ?? 'unknown error'}` })
  return out
}

const RETRY_REASONS: Record<string, string> = {
  rate_limit: 'rate limited',
  overloaded: 'API overloaded',
  server_error: 'server error',
  authentication_failed: 'authentication failed',
  billing_error: 'billing problem',
  max_output_tokens: 'reply too long'
}

/** A short reason for an api_retry record: its error category, plus the HTTP status. */
export function retryReason(error: unknown, status: unknown): string {
  const what = typeof error === 'string' ? RETRY_REASONS[error] ?? error.replace(/_/g, ' ') : 'request failed'
  return typeof status === 'number' ? `${what} (${status})` : what
}

/** A notice for a usage limit that is close (`allowed_warning`) or reached (`rejected`). */
function limitText(status: string, info: any): string {
  const window = typeof info.rateLimitType === 'string' ? info.rateLimitType.replace(/_/g, '-') : ''
  const resets = typeof info.resetsAt === 'number' ? ` It resets at ${new Date(info.resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''
  const which = window ? `your ${window} usage limit` : 'your usage limit'
  return status === 'rejected' ? `You've reached ${which}.${resets}` : `You're close to ${which}.${resets}`
}

/**
 * What to ask the user for a can_use_tool request. ExitPlanMode has none: its
 * plan is already in the transcript, and the adapter turns it into the
 * plan-approval step.
 */
export function promptFor(req: any): UserPrompt | null {
  if (req.tool_name === 'ExitPlanMode') return null
  if (req.tool_name === 'AskUserQuestion' && Array.isArray(req.input?.questions)) {
    const questions: PromptQuestion[] = req.input.questions.map((q: any) => ({
      question: String(q?.question ?? ''),
      header: q?.header,
      options: Array.isArray(q?.options) ? q.options.map((o: any) => ({ label: String(o?.label ?? o), description: o?.description })) : [],
      multiSelect: !!q?.multiSelect
    }))
    return { type: 'questions', questions }
  }
  return {
    type: 'tool-approval',
    tool: req.display_name ?? req.tool_name ?? 'Tool',
    input: req.input,
    description: req.description,
    canAlways: alwaysRules(req).length > 0
  }
}

/** Claude's own "don't ask again" rules for a request, scoped to this session. */
function alwaysRules(req: any): any[] {
  const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : []
  return suggestions.filter((s: any) => s?.type === 'addRules').map((s: any) => ({ ...s, destination: 'session' }))
}

/** The control_response body for a user's answer to a can_use_tool request. */
export function permissionResponse(req: any, answer: PromptAnswer): Record<string, unknown> {
  if ('answers' in answer) return { behavior: 'allow', updatedInput: { ...req.input, answers: answer.answers } }
  if ('allow' in answer && answer.allow) {
    const rules = answer.always ? alwaysRules(req) : []
    return { behavior: 'allow', updatedInput: req.input, ...(rules.length && { updatedPermissions: rules }) }
  }
  return {
    behavior: 'deny',
    message: req.tool_name === 'AskUserQuestion' ? 'The user dismissed the question.' : 'The user denied this tool call.'
  }
}

/** A prompt as stream-json content: plain text, or text plus image blocks. */
export function userContent(text: string, images: ImageAttachment[]): string | unknown[] {
  if (!images.length) return text
  const blocks: unknown[] = images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } }))
  return text ? [{ type: 'text', text }, ...blocks] : blocks
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content.map((c) => (c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : '')).join('\n')
  return ''
}

/** `modelUsage` is cumulative across the session, so totals come from it. */
function resultStats(rec: any) {
  const stats = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, contextMax: 0, costUsd: 0 }
  const models = Object.values<any>(rec.modelUsage ?? {})
  if (models.length) {
    for (const m of models) {
      stats.inputTokens += m.inputTokens ?? 0
      stats.outputTokens += m.outputTokens ?? 0
      stats.cacheRead += m.cacheReadInputTokens ?? 0
      stats.cacheWrite += m.cacheCreationInputTokens ?? 0
      stats.costUsd += m.costUSD ?? 0
      stats.contextMax = Math.max(stats.contextMax, m.contextWindow ?? 0)
    }
  } else if (rec.usage) {
    stats.inputTokens = rec.usage.input_tokens ?? 0
    stats.outputTokens = rec.usage.output_tokens ?? 0
    stats.cacheRead = rec.usage.cache_read_input_tokens ?? 0
    stats.cacheWrite = rec.usage.cache_creation_input_tokens ?? 0
  }
  if (typeof rec.total_cost_usd === 'number') stats.costUsd = rec.total_cost_usd
  const { contextMax, ...rest } = stats
  return contextMax ? stats : rest
}

/** Aliases the Claude Code CLI resolves to the latest model in each family. */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' }
]
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Plan mode is Claude's own `plan`; auto uses the configured permission mode. */
export function permissionModeFor(settings: AdapterSettings, mode: AgentMode): string {
  return mode === 'plan' ? 'plan' : settings.permissionMode
}

function modeOf(permissionMode: string): AgentMode {
  return permissionMode === 'plan' ? 'plan' : 'auto'
}

export function claudeArgs(settings: AdapterSettings, config: AgentConfig, resumeId?: string): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Without this, subagents' own text/thinking never reaches the stream.
    '--forward-subagent-text',
    '--permission-mode', permissionModeFor(settings, config.mode)
  ]
  if (config.model) args.push('--model', config.model)
  if (config.effort) args.push('--effort', config.effort)
  if (resumeId) args.push('--resume', resumeId)
  // Permission requests come to us as can_use_tool control requests.
  if (settings.approvals === 'ask') args.push('--permission-prompt-tool', 'stdio')
  return args
}

export class ClaudeAdapter extends ProcessAdapter {
  private cwd = ''
  private config: AgentConfig = defaultConfig()
  private sessionId = ''
  private busy = false
  /** A model/effort change requested mid-turn, applied when the turn ends. */
  private pending: Partial<AgentConfig> | null = null
  /** can_use_tool requests waiting on the user, by request id. */
  private requests = new Map<string, any>()
  /** The ExitPlanMode request holding a finished plan, if Claude is waiting on one. */
  private planRequest: string | null = null

  constructor(emit: Emit, private settings: AdapterSettings) {
    super(emit, new ClaudeTranslator())
  }

  start(opts: StartOptions): void {
    this.cwd = opts.cwd
    this.config = { model: opts.model ?? '', effort: opts.effort ?? '', mode: opts.mode ?? 'auto' }
    // A saved session continues through the same --resume used for relaunches.
    this.sessionId = opts.resume?.id ?? ''
    this.emit({ kind: 'options', models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS })
    this.emit({ kind: 'config', config: this.config })
    this.launch()
  }

  /** Claude queues a message sent mid-turn itself, so there is no follow-up option. */
  send(text: string, images: ImageAttachment[] = []): void {
    this.busy = true
    this.emit({ kind: 'user-message', text, ...(images.length && { images }) })
    this.emit({ kind: 'turn-start' })
    // Claude is still waiting on its plan: a reply refines it instead.
    const plan = this.takePlanRequest()
    if (plan) this.respond(plan, { behavior: 'deny', message: `The user wants changes before running the plan: ${text}` })
    else this.write({ type: 'user', message: { role: 'user', content: userContent(text, images) } })
  }

  /** Claude's stream-json mode has an `interrupt` control request. */
  abort(): void {
    // Release anything Claude is blocked on first, so the interrupt can land.
    for (const id of [...this.requests.keys()]) this.answerPrompt(id, { cancelled: true })
    this.write({ type: 'control_request', request_id: `abort-${Date.now()}`, request: { subtype: 'interrupt' } })
  }

  /** `/compact` works in stream-json input like any slash command; Claude answers with compact_boundary. */
  compact(): void {
    if (this.busy) {
      this.emit({ kind: 'notice', text: 'Compact once the current turn finishes.' })
      return
    }
    this.busy = true
    this.emit({ kind: 'notice', text: 'Compacting the conversation…' })
    this.emit({ kind: 'turn-start' })
    this.write({ type: 'user', message: { role: 'user', content: '/compact' } })
  }

  clearQueue(): void {}

  answerPrompt(id: string, answer: PromptAnswer): void {
    const req = this.requests.get(id)
    if (!req) return
    if (id === this.planRequest) this.planRequest = null
    this.respond(id, permissionResponse(req, answer))
  }

  private respond(id: string, response: Record<string, unknown>) {
    this.requests.delete(id)
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
    this.emit({ kind: 'prompt-resolved', id })
  }

  private takePlanRequest(): string | null {
    const id = this.planRequest
    this.planRequest = null
    return id && this.requests.has(id) ? id : null
  }

  /**
   * Mode switches live through a control request, even mid-turn. Model and
   * effort are CLI flags, so a change means relaunching with --resume; wait
   * for the current turn to finish so no work is cut off.
   */
  configure(change: Partial<AgentConfig>): void {
    const { mode, ...rest } = change
    if (mode && mode !== this.config.mode) this.setMode(mode)
    if (!Object.keys(rest).length) return
    this.pending = { ...this.pending, ...rest }
    if (this.busy) this.emit({ kind: 'notice', text: 'The new settings apply when the current turn finishes.' })
    else this.applyPending()
  }

  approvePlan(): void {
    const plan = this.takePlanRequest()
    if (!plan) {
      this.configure({ mode: 'auto' })
      this.send(PLAN_APPROVAL)
      return
    }
    // Claude leaves plan mode itself when ExitPlanMode is allowed; then move
    // it to the configured auto mode rather than whatever it picks.
    this.respond(plan, { behavior: 'allow', updatedInput: this.requests.get(plan)?.input ?? {} })
    this.setMode('auto')
    this.emit({ kind: 'turn-start' })
  }

  private setMode(mode: AgentMode) {
    this.config.mode = mode
    // Claude confirms with a status record, which updates the UI.
    const permission = permissionModeFor(this.settings, mode)
    this.write({ type: 'control_request', request_id: `mode-${Date.now()}`, request: { subtype: 'set_permission_mode', mode: permission } })
    this.emit({ kind: 'notice', text: describeMode(mode) })
  }

  protected onRecord(rec: any): void {
    if (rec.type === 'control_request' && rec.request?.subtype === 'can_use_tool') {
      this.requests.set(rec.request_id, rec.request)
      if (rec.request.tool_name === 'ExitPlanMode') {
        // Claude holds the turn open until the plan is answered, but the plan
        // is ready: end the turn in the UI so it can be approved or refined.
        this.planRequest = rec.request_id
        this.emit({ kind: 'turn-end' })
        return
      }
    }
    super.onRecord(rec)
    if (rec.type === 'system' && rec.subtype === 'init' && rec.session_id) this.sessionId = rec.session_id
    // Keep relaunches in the mode Claude is really in (it may leave plan mode itself).
    if (rec.type === 'system' && typeof rec.permissionMode === 'string') this.config.mode = modeOf(rec.permissionMode)
    if (rec.type === 'control_response' && rec.response?.subtype === 'error')
      this.emit({ kind: 'error', message: rec.response.error ?? 'Claude rejected a control request.' })
    if (rec.type === 'control_cancel_request') this.requests.delete(rec.request_id)
    if (rec.type === 'result') {
      this.busy = false
      // Anything still open belonged to the turn that just ended.
      for (const id of this.requests.keys()) this.emit({ kind: 'prompt-resolved', id })
      this.requests.clear()
      this.planRequest = null
      if (this.pending) this.applyPending()
    }
  }

  private applyPending() {
    const next = { ...this.config, ...this.pending }
    this.pending = null
    if (next.model === this.config.model && next.effort === this.config.effort) return
    this.config = next
    this.launch()
    this.emit({ kind: 'config', config: next })
    this.emit({ kind: 'notice', text: describeConfig(next) })
  }

  private launch() {
    this.spawn(this.settings.claudePath, claudeArgs(this.settings, this.config, this.sessionId || undefined), this.cwd)
  }
}

export function describeConfig(c: AgentConfig): string {
  const effort = c.effort === 'xhigh' ? 'extra high' : c.effort
  return `Now using ${c.model || 'the default model'} with ${effort ? `${effort} effort` : 'default effort'}.`
}
