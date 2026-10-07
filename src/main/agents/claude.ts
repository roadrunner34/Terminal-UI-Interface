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
  type ClaudeSessionOptions,
  type ContextUsage,
  type ImageAttachment,
  type McpAction,
  type McpServer,
  type ModelOption,
  type PromptAnswer,
  type PromptQuestion,
  type Scope,
  type StartOptions,
  type UserPrompt
} from '@shared/events'
import { describeMode, PLAN_APPROVAL } from '@shared/format'
import { randomUUID } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { tempFile } from './options'
import { ProcessAdapter } from './process'
import type { AdapterSettings, Emit, Translator } from './types'

const SUBAGENT_TOOLS = new Set(['Task', 'Agent'])

/** Hooks that finish faster than this, without failing, stay out of the transcript. */
export const QUIET_HOOK_MS = 1500

/** Background task states that mean it's over. Stopping one isn't a failure. */
const TASK_ENDS: Record<string, 'done' | 'error'> = { completed: 'done', failed: 'error', killed: 'done', stopped: 'done' }

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
  /** Hooks that started, and whether they're shown yet (slow or failing ones are). */
  private hooks = new Map<string, { name: string; at: number; shown: boolean }>()
  /** Background task id → its subagent card. */
  private tasks = new Map<string, string>()
  /** Agent subagents moved to the background: they outlive the turn that started them. */
  private bgAgents = new Set<string>()

  /** `clock` decides which hooks are slow enough to show; tests pass their own. */
  constructor(private clock: () => number = Date.now) {}

  handle(rec: any): AgentEvent[] {
    const out: AgentEvent[] = []
    const scope = this.scopeOf(rec.parent_tool_use_id)
    const key = scope === 'main' ? 'main' : scope.subagentId

    switch (rec.type) {
      case 'system':
        // Claude sends init before every turn, including ones it starts by
        // itself (e.g. to report a finished background task).
        if (rec.subtype === 'init') {
          out.push({ kind: 'session', agent: 'claude', sessionId: rec.session_id ?? '', model: rec.model ?? '' })
          out.push({ kind: 'turn-start' })
        }
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
        if (rec.subtype === 'session_title_changed' && typeof rec.title === 'string') out.push({ kind: 'title', title: rec.title })
        if (rec.subtype?.startsWith('hook_')) out.push(...this.hook(rec))
        if (rec.subtype?.startsWith('task_')) out.push(...this.task(rec))
        if (rec.subtype === 'permission_denied') {
          const tool = rec.tool_name ?? rec.display_name ?? 'A tool call'
          const why = rec.message ?? rec.reason
          out.push({ kind: 'notice', text: `${tool} was denied${why ? `: ${why}` : '.'}` })
        }
        break

      case 'control_response': {
        const res = rec.response ?? {}
        if (res.subtype === 'success' && String(res.request_id).startsWith('ctx-') && res.response)
          out.push({ kind: 'context-usage', usage: contextUsageFrom(res.response) })
        if (res.subtype === 'success' && String(res.request_id).startsWith('mcp-status-') && res.response)
          out.push({ kind: 'mcp', servers: mcpStatusFrom(res.response) })
        break
      }

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
        if (rec.subtype === 'error_max_budget_usd') out.push({ kind: 'notice', text: budgetText(rec) })
        else if (rec.is_error && rec.subtype !== 'success')
          out.push({ kind: 'error', message: rec.result ?? rec.subtype ?? 'Agent error' })
        out.push({ kind: 'turn-end' })
        break
      }
    }
    return out
  }

  /**
   * Hooks show as tool calls named "Hook", but only slow or failing ones:
   * every launch runs SessionStart hooks, and quick successes are noise.
   */
  private hook(rec: any): AgentEvent[] {
    const id = String(rec.hook_id ?? '')
    if (!id) return []
    const name = String(rec.hook_name ?? rec.hook_event ?? 'hook')
    const out: AgentEvent[] = []
    const show = (h: { shown: boolean }) => {
      if (h.shown) return
      h.shown = true
      out.push({ kind: 'tool-start', scope: 'main', toolId: `hook-${id}`, name: 'Hook', input: { description: name } })
    }
    if (rec.subtype === 'hook_started') {
      this.hooks.set(id, { name, at: this.clock(), shown: false })
    } else if (rec.subtype === 'hook_progress') {
      const h = this.hooks.get(id) ?? { name, at: this.clock(), shown: false }
      this.hooks.set(id, h)
      show(h)
      const text = hookOutput(rec)
      if (text) out.push({ kind: 'tool-update', scope: 'main', toolId: `hook-${id}`, output: text })
    } else if (rec.subtype === 'hook_response') {
      const h = this.hooks.get(id) ?? { name, at: this.clock(), shown: false }
      this.hooks.delete(id)
      const failed = (rec.outcome !== undefined && rec.outcome !== 'success') || (typeof rec.exit_code === 'number' && rec.exit_code !== 0)
      if (!failed && !h.shown && this.clock() - h.at < QUIET_HOOK_MS) return []
      show(h)
      out.push({ kind: 'tool-end', scope: 'main', toolId: `hook-${id}`, output: hookOutput(rec), isError: failed })
    }
    return out
  }

  /**
   * Background tasks (a backgrounded shell command or subagent) get a card
   * the user can stop. A backgrounded Agent call already has one; it just
   * stops being tied to the turn.
   */
  private task(rec: any): AgentEvent[] {
    const taskId = String(rec.task_id ?? '')
    if (!taskId) return []
    const out: AgentEvent[] = []
    if (rec.subtype === 'task_started') {
      const toolId = rec.tool_use_id
      if (toolId && this.subagents.has(toolId)) {
        this.tasks.set(taskId, toolId)
        if (rec.is_backgrounded) {
          // Its tool call returns right away; that isn't the subagent finishing.
          this.subagents.delete(toolId)
          this.bgAgents.add(toolId)
          out.push({ kind: 'subagent-update', subagentId: toolId, taskId, activity: 'Running in the background' })
        } else out.push({ kind: 'subagent-update', subagentId: toolId, taskId })
      } else if (rec.is_backgrounded) {
        const cardId = `task:${taskId}`
        this.tasks.set(taskId, cardId)
        out.push({ kind: 'subagent-start', subagentId: cardId, label: String(rec.description ?? 'Background task'), agentType: taskType(rec.task_type), taskId })
        out.push({ kind: 'subagent-update', subagentId: cardId, activity: 'Running in the background' })
      }
      return out
    }
    const cardId = this.tasks.get(taskId)
    if (!cardId) return []
    const status = rec.subtype === 'task_updated' ? rec.patch?.status : rec.subtype === 'task_notification' ? rec.status : undefined
    if (rec.subtype === 'task_progress') {
      const activity = rec.description ?? rec.summary ?? (rec.last_tool_name && `▸ ${rec.last_tool_name}`)
      if (activity) out.push({ kind: 'subagent-update', subagentId: cardId, activity: String(activity) })
    }
    if (rec.subtype === 'task_notification' && rec.summary) {
      out.push({ kind: 'text', scope: { subagentId: cardId }, messageId: `${cardId}-summary`, text: String(rec.summary) })
      out.push({ kind: 'subagent-update', subagentId: cardId, activity: String(rec.summary) })
    }
    const end = typeof status === 'string' ? TASK_ENDS[status] : undefined
    if (end) {
      if (status === 'killed' || status === 'stopped') out.push({ kind: 'subagent-update', subagentId: cardId, activity: 'Stopped' })
      out.push({ kind: 'subagent-end', subagentId: cardId, status: end })
      this.bgAgents.delete(cardId)
    }
    return out
  }

  private noteModel(scope: Scope, model: unknown, out: AgentEvent[]) {
    if (scope === 'main' || typeof model !== 'string' || !model) return
    const id = scope.subagentId
    if (!(this.subagents.has(id) || this.bgAgents.has(id)) || this.subagentModels.get(id) === model) return
    this.subagentModels.set(id, model)
    out.push({ kind: 'subagent-update', subagentId: id, model })
  }

  private scopeOf(parent: string | null | undefined): Scope {
    return parent ? { subagentId: parent } : 'main'
  }
}

/** The --max-budget-usd stop: Claude says "Reached maximum budget ($X)". */
function budgetText(rec: any): string {
  const said = (Array.isArray(rec.errors) ? rec.errors : []).map(String).join(' ')
  const cap = /\$\s?([\d.]+)/.exec(said)?.[1]
  return `${cap ? `Budget of $${cap}` : 'The budget'} reached. Start a new session or raise the cap under Advanced.`
}

/** A hook's output for its row: what it printed, errors first. */
function hookOutput(rec: any): string {
  return String(rec.stderr || rec.stdout || rec.output || '').trim()
}

function taskType(t: unknown): string {
  if (t === 'local_bash') return 'background shell'
  if (t === 'local_agent') return 'background agent'
  return typeof t === 'string' ? t.replace(/_/g, ' ') : 'background task'
}

/** get_context_usage's answer, trimmed to what the breakdown shows. */
export function contextUsageFrom(r: any): ContextUsage {
  const categories = (Array.isArray(r?.categories) ? r.categories : [])
    .filter((c: any) => typeof c?.name === 'string' && typeof c?.tokens === 'number')
    .map((c: any) => ({ name: c.name, tokens: c.tokens, kind: String(c.kind ?? (c.isDeferred ? 'deferred' : 'used')) }))
  return { total: r?.totalTokens ?? 0, max: r?.maxTokens ?? 0, categories }
}

/** mcp_status's answer: every server, with its tools once connected. */
export function mcpStatusFrom(r: any): McpServer[] {
  return (Array.isArray(r?.mcpServers) ? r.mcpServers : [])
    .filter((m: any) => typeof m?.name === 'string')
    .map((m: any) => {
      const s: McpServer = { name: m.name, status: String(m.status ?? 'unknown') }
      if (m.error) s.error = String(m.error)
      if (typeof m.serverInfo?.version === 'string') s.version = m.serverInfo.version
      if (typeof m.scope === 'string') s.scope = m.scope
      if (typeof m.source === 'string') s.source = m.source
      if (typeof m.config?.type === 'string') s.transport = m.config.type
      if (Array.isArray(m.tools))
        s.tools = m.tools
          .filter((t: any) => typeof t?.name === 'string')
          .map((t: any) => (t.annotations?.readOnly ? { name: t.name, readOnly: true } : { name: t.name }))
      return s
    })
}

/** The control request for an MCP action (see McpAction). */
export function mcpRequest(action: McpAction, serverName: string): Record<string, unknown> {
  switch (action) {
    case 'status':
      return { subtype: 'mcp_status' }
    case 'reconnect':
      return { subtype: 'mcp_reconnect', serverName }
    case 'enable':
    case 'disable':
      return { subtype: 'mcp_toggle', serverName, enabled: action === 'enable' }
    case 'auth':
      return { subtype: 'mcp_authenticate', serverName }
    case 'logout':
      return { subtype: 'mcp_clear_auth', serverName }
  }
}

const MCP_DONE: Partial<Record<McpAction, (name: string) => string>> = {
  reconnect: (n) => `Reconnected ${n}.`,
  enable: (n) => `Enabled ${n}. This is saved to your Claude settings.`,
  disable: (n) => `Disabled ${n}. This is saved to your Claude settings.`,
  logout: (n) => `Signed out of ${n}.`
}

/** The URL, normalized, if it is https; anything else is never opened. */
function httpsUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** How often, and how long, to check whether a browser sign-in finished. */
export const MCP_AUTH_POLL_MS = 3000
export const MCP_AUTH_POLL_MAX = 40

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

/**
 * `forkAt` copies the resumed session into a new one, cut off after that
 * assistant message ('' keeps all of it).
 */
export function claudeArgs(
  settings: AdapterSettings,
  config: AgentConfig,
  resumeId?: string,
  forkAt?: string,
  advanced: ClaudeSessionOptions = {},
  /** The temp file holding advanced.appendSystemPrompt. */
  appendFile?: string
): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Without this, subagents' own text/thinking never reaches the stream.
    '--forward-subagent-text',
    // Hook progress, so a slow or failing hook doesn't look like a hang.
    '--include-hook-events',
    '--permission-mode', permissionModeFor(settings, config.mode)
  ]
  if (config.model) args.push('--model', config.model)
  if (config.effort) args.push('--effort', config.effort)
  if (resumeId) args.push('--resume', resumeId)
  if (resumeId && forkAt !== undefined) {
    args.push('--fork-session')
    // Only the = form is read by this (undocumented) flag.
    if (forkAt) args.push(`--resume-session-at=${forkAt}`)
  }
  // Permission requests come to us as can_use_tool control requests.
  if (settings.approvals === 'ask') args.push('--permission-prompt-tool', 'stdio')
  return [...args, ...claudeAdvancedArgs(advanced, appendFile)]
}

/** Flags for the per-session options. Multi-value flags end at the next flag. */
export function claudeAdvancedArgs(o: ClaudeSessionOptions, appendFile?: string): string[] {
  const args: string[] = []
  // A file, so long text never reaches the command line (hidden flag, in 2.1.292).
  if (o.appendSystemPrompt && appendFile) args.push('--append-system-prompt-file', appendFile)
  if (o.addDirs?.length) args.push('--add-dir', ...o.addDirs)
  if (o.mcpConfigs?.length) {
    args.push('--mcp-config', ...o.mcpConfigs)
    if (o.strictMcp) args.push('--strict-mcp-config')
  }
  // A file is only accepted with -p, which we always use.
  if (o.agentsFile) args.push('--agents', o.agentsFile)
  if (o.maxBudgetUsd && o.maxBudgetUsd > 0) args.push('--max-budget-usd', String(o.maxBudgetUsd))
  if (o.fallbackModel) args.push('--fallback-model', o.fallbackModel)
  if (o.allowedTools) args.push('--allowedTools', o.allowedTools)
  if (o.disallowedTools) args.push('--disallowedTools', o.disallowedTools)
  if (o.bare) args.push('--bare')
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
  /** Our prompts by uuid: their text, and the assistant message before them (where a fork resumes). */
  private sent = new Map<string, { text: string; after: string }>()
  /** The latest main-conversation assistant message. */
  private lastAssistant = ''
  /** A fork waiting for its first prompt: until Claude names the new session, relaunches redo it. */
  private forkFrom: { id: string; at: string } | null = null
  /** File restores waiting on a dry run or on the user: request or prompt id → prompt uuid. */
  private rewinds = new Map<string, string>()
  /** MCP actions waiting on Claude's answer, by request id. */
  private mcpRequests = new Map<string, { action: McpAction; name: string }>()
  /** Per-session flags, kept for every relaunch. */
  private advanced: ClaudeSessionOptions = {}
  private appendFile: { path: string; remove(): void } | null = null
  /** A browser sign-in we're watching for, polling mcp_status. */
  private signIn: { name: string; timer: ReturnType<typeof setInterval> } | null = null
  private seq = 0

  constructor(emit: Emit, private settings: AdapterSettings) {
    super(emit, new ClaudeTranslator())
  }

  start(opts: StartOptions): void {
    this.cwd = opts.cwd
    this.config = { model: opts.model ?? '', effort: opts.effort ?? '', mode: opts.mode ?? 'auto' }
    this.advanced = (opts.advanced ?? {}) as ClaudeSessionOptions
    // A saved session continues through the same --resume used for relaunches.
    this.sessionId = opts.resume?.id ?? ''
    this.emit({ kind: 'options', models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS })
    this.emit({ kind: 'config', config: this.config })
    this.launch()
    // Answered before the first prompt (servers show as pending until they connect).
    this.mcp('status')
  }

  /** Claude queues a message sent mid-turn itself, so there is no follow-up option. */
  send(text: string, images: ImageAttachment[] = []): void {
    this.busy = true
    // Claude is still waiting on its plan: a reply refines it instead.
    const plan = this.takePlanRequest()
    if (plan) {
      this.emit({ kind: 'user-message', text, ...(images.length && { images }) })
      this.emit({ kind: 'turn-start' })
      this.respond(plan, { behavior: 'deny', message: `The user wants changes before running the plan: ${text}` })
      return
    }
    // Our own uuid names the prompt, so it can be forked from or rewound to later.
    const uuid = randomUUID()
    this.sent.set(uuid, { text, after: this.lastAssistant })
    this.emit({ kind: 'user-message', text, entryId: uuid, ...(images.length && { images }) })
    this.emit({ kind: 'turn-start' })
    this.write({ type: 'user', uuid, message: { role: 'user', content: userContent(text, images) } })
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

  contextUsage(): void {
    this.control(`ctx-${++this.seq}`, { subtype: 'get_context_usage' })
  }

  stopTask(taskId: string): void {
    this.control(`stop-${++this.seq}`, { subtype: 'stop_task', task_id: taskId })
  }

  shell(): void {
    this.emit({ kind: 'notice', text: 'Shell commands (!) are only available with Pi.' })
  }

  /** Claude confirms with session_title_changed, which updates the tab. */
  rename(title: string): void {
    this.control(`rename-${++this.seq}`, { subtype: 'rename_session', title, source: 'host' })
  }

  /** Claude's transcript is already a file; copy it. */
  async exportSession(path: string): Promise<void> {
    if (!this.sessionId) {
      this.emit({ kind: 'notice', text: 'Nothing to export yet: send a message first.' })
      return
    }
    try {
      // Loaded here: the history module itself imports this one.
      const { listClaude } = await import('../history/claude')
      const saved = (await listClaude(this.cwd)).find((s) => s.id === this.sessionId)
      if (!saved) throw new Error('its transcript file was not found')
      await copyFile(saved.path, path)
      this.emit({ kind: 'notice', text: `Exported the transcript to ${path}.` })
    } catch (err) {
      this.emit({ kind: 'error', message: `Couldn't export the session: ${err instanceof Error ? err.message : err}` })
    }
  }

  /**
   * Relaunch on a copy of the session that ends before this prompt, and hand
   * the prompt back to edit. The first prompt has nothing before it, so that
   * fork is simply a fresh session.
   */
  fork(entryId: string): void {
    const prompt = this.sent.get(entryId)
    if (!prompt) return this.emit({ kind: 'notice', text: 'This message can only be forked from in the session that sent it.' })
    if (this.busy) return this.emit({ kind: 'notice', text: 'Fork once the current turn finishes.' })
    for (const id of this.requests.keys()) this.emit({ kind: 'prompt-resolved', id })
    this.requests.clear()
    this.planRequest = null
    if (prompt.after && this.sessionId) this.forkFrom = { id: this.forkFrom?.id ?? this.sessionId, at: prompt.after }
    else {
      this.forkFrom = null
      this.sessionId = ''
    }
    this.lastAssistant = prompt.after
    this.launch()
    this.emit({ kind: 'truncate', entryId })
    this.emit({ kind: 'draft', text: prompt.text })
    this.emit({ kind: 'notice', text: 'Forked from before that message. Edit it and send to continue on the new branch.' })
  }

  /** A dry run first, so the user sees what would change before agreeing. */
  rewind(entryId: string): void {
    if (!this.sent.has(entryId))
      return this.emit({ kind: 'notice', text: 'Files can only be restored to messages sent in this session.' })
    if (this.busy) return this.emit({ kind: 'notice', text: 'Restore files once the current turn finishes.' })
    const id = `rewind-dry-${++this.seq}`
    this.rewinds.set(id, entryId)
    this.control(id, { subtype: 'rewind_files', user_message_id: entryId, dry_run: true })
  }

  private control(id: string, request: Record<string, unknown>) {
    this.write({ type: 'control_request', request_id: id, request })
  }

  mcp(action: McpAction, name = ''): void {
    if (action !== 'status') {
      if (!name) return
      this.emit({ kind: 'mcp-busy', name, busy: true })
    }
    const id = `mcp-${action}-${++this.seq}`
    this.mcpRequests.set(id, { action, name })
    this.control(id, mcpRequest(action, name))
  }

  /**
   * Answers to MCP actions. Each success or failure is a notice, then the
   * list refreshes. A sign-in opens the browser; Claude takes the callback on
   * localhost itself, so we only watch for the status to change.
   */
  private onMcpResponse(id: string, res: any) {
    const req = this.mcpRequests.get(id)
    this.mcpRequests.delete(id)
    if (!req) return
    const failed = res?.subtype === 'error'
    if (req.action === 'status') {
      if (failed) this.emit({ kind: 'notice', text: `Couldn't get MCP status: ${res.error ?? 'unknown error'}` })
      else this.checkSignIn(mcpStatusFrom(res.response))
      return
    }
    this.emit({ kind: 'mcp-busy', name: req.name, busy: false })
    if (failed) {
      this.emit({ kind: 'notice', text: `${req.name}: ${res.error ?? 'the request failed'}` })
    } else if (req.action === 'auth') {
      this.startSignIn(req.name, res.response ?? {})
    } else {
      this.emit({ kind: 'notice', text: MCP_DONE[req.action]!(req.name) })
    }
    this.mcp('status')
  }

  private startSignIn(name: string, r: any) {
    if (r.callbackExpected && r.redirectScheme === 'custom') {
      this.emit({ kind: 'notice', text: `Finish signing in to ${name} with \`claude /mcp\` in a terminal.` })
      return
    }
    // No URL: nothing to open (it may already be signed in); the refresh shows it.
    if (typeof r.authUrl !== 'string') return
    const url = httpsUrl(r.authUrl)
    if (!url || !this.settings.openUrl) {
      this.emit({ kind: 'notice', text: `Sign in to ${name} at ${r.authUrl}` })
      return
    }
    this.settings.openUrl(url)
    this.emit({ kind: 'notice', text: `Opened the sign-in page for ${name} in your browser.` })
    this.stopSignInPoll()
    let left = MCP_AUTH_POLL_MAX
    this.signIn = {
      name,
      timer: setInterval(() => {
        if (--left < 0) {
          this.stopSignInPoll()
          this.emit({ kind: 'notice', text: `Still waiting on the sign-in for ${name}. Check the MCP list again once you've finished.` })
        } else this.mcp('status')
      }, MCP_AUTH_POLL_MS)
    }
  }

  private checkSignIn(servers: McpServer[]) {
    if (!this.signIn) return
    const server = servers.find((s) => s.name === this.signIn!.name)
    if (!server || server.status === 'needs-auth' || server.status === 'pending') return
    const { name } = this.signIn
    this.stopSignInPoll()
    this.emit({
      kind: 'notice',
      text: server.status === 'connected' ? `Signed in to ${name}.` : `${name} is ${server.status.replace('-', ' ')} after signing in.`
    })
  }

  private stopSignInPoll() {
    if (this.signIn) clearInterval(this.signIn.timer)
    this.signIn = null
  }

  dispose(): void {
    this.stopSignInPoll()
    super.dispose()
    this.appendFile?.remove()
    this.appendFile = null
  }

  /** Answers to rewind_files: the dry run asks the user, the real one reports back. */
  private onRewindResponse(id: string, res: any) {
    const entryId = this.rewinds.get(id)
    this.rewinds.delete(id)
    if (!entryId) return
    const r = res?.response ?? {}
    if (res?.subtype === 'error' || r.canRewind === false) {
      const why = r.error ?? res?.error ?? 'unknown error'
      this.emit({ kind: 'notice', text: `Can't restore files: ${why}` })
      return
    }
    if (id.startsWith('rewind-go-')) {
      this.emit({ kind: 'notice', text: 'Restored files to how they were before that message.' })
      return
    }
    const files: string[] = Array.isArray(r.filesChanged) ? r.filesChanged : []
    if (!files.length) {
      this.emit({ kind: 'notice', text: 'No files have changed since that message.' })
      return
    }
    const promptId = `rewind-${++this.seq}`
    this.rewinds.set(promptId, entryId)
    const names = files.map((f) => basename(f))
    const counts = typeof r.insertions === 'number' ? ` (+${r.insertions} −${r.deletions ?? 0})` : ''
    this.emit({
      kind: 'prompt-request',
      id: promptId,
      scope: 'main',
      prompt: {
        type: 'confirm',
        title: `Restore ${files.length} file${files.length === 1 ? '' : 's'} to before this message?`,
        message: `${names.slice(0, 8).join(', ')}${names.length > 8 ? ` and ${names.length - 8} more` : ''}${counts}. The conversation stays as it is.`
      }
    })
  }

  answerPrompt(id: string, answer: PromptAnswer): void {
    if (id.startsWith('rewind-') && this.rewinds.has(id)) {
      const entryId = this.rewinds.get(id)!
      this.rewinds.delete(id)
      this.emit({ kind: 'prompt-resolved', id })
      const yes = ('confirmed' in answer && answer.confirmed) || ('allow' in answer && answer.allow)
      if (!yes) return
      const goId = `rewind-go-${++this.seq}`
      this.rewinds.set(goId, entryId)
      this.control(goId, { subtype: 'rewind_files', user_message_id: entryId })
      return
    }
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
    if (rec.type === 'system' && rec.subtype === 'init') {
      this.busy = true
      if (rec.session_id) this.sessionId = rec.session_id
      // The fork is now a session of its own.
      this.forkFrom = null
    }
    if (rec.type === 'assistant' && !rec.parent_tool_use_id && rec.uuid) this.lastAssistant = rec.uuid
    if (rec.type === 'control_response' && String(rec.response?.request_id).startsWith('rewind-')) {
      this.onRewindResponse(rec.response.request_id, rec.response)
      return
    }
    // MCP errors are about one server, not the session: they become notices.
    if (rec.type === 'control_response' && String(rec.response?.request_id).startsWith('mcp-')) {
      this.onMcpResponse(rec.response.request_id, rec.response)
      return
    }
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
    // Written once per session; relaunches (model change, fork) reuse it.
    if (this.advanced.appendSystemPrompt && !this.appendFile)
      this.appendFile = tempFile('append.md', this.advanced.appendSystemPrompt)
    const file = this.appendFile?.path
    const args = this.forkFrom
      ? claudeArgs(this.settings, this.config, this.forkFrom.id, this.forkFrom.at, this.advanced, file)
      : claudeArgs(this.settings, this.config, this.sessionId || undefined, undefined, this.advanced, file)
    // Checkpoints let rewind() put files back; off unless asked for in -p mode.
    this.spawn(this.settings.claudePath, args, this.cwd, { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' })
  }
}

export function describeConfig(c: AgentConfig): string {
  const effort = c.effort === 'xhigh' ? 'extra high' : c.effort
  return `Now using ${c.model || 'the default model'} with ${effort ? `${effort} effort` : 'default effort'}.`
}
