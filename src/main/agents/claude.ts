// Claude Code adapter: `claude -p` with stream-json in both directions.
//
// Subagents: when the model calls the Task/Agent tool, every later message
// produced by that subagent carries `parent_tool_use_id` = that tool_use id.
// We use the tool_use id as the subagent id and route those messages to it.
import type { AgentConfig, AgentEvent, ModelOption, Scope, StartOptions } from '@shared/events'
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

  handle(rec: any): AgentEvent[] {
    const out: AgentEvent[] = []
    const scope = this.scopeOf(rec.parent_tool_use_id)
    const key = scope === 'main' ? 'main' : scope.subagentId

    switch (rec.type) {
      case 'system':
        if (rec.subtype === 'init')
          out.push({ kind: 'session', agent: 'claude', sessionId: rec.session_id ?? '', model: rec.model ?? '' })
        break

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
            out.push({ kind: 'tool-start', scope, toolId: block.id, name: block.name, input: block.input })
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

export function claudeArgs(settings: AdapterSettings, config: AgentConfig, resumeId?: string): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Without this, subagents' own text/thinking never reaches the stream.
    '--forward-subagent-text',
    '--permission-mode', settings.permissionMode
  ]
  if (config.model) args.push('--model', config.model)
  if (config.effort) args.push('--effort', config.effort)
  if (resumeId) args.push('--resume', resumeId)
  return args
}

export class ClaudeAdapter extends ProcessAdapter {
  private cwd = ''
  private config: AgentConfig = { model: '', effort: '' }
  private sessionId = ''
  private busy = false
  /** A model/effort change requested mid-turn, applied when the turn ends. */
  private pending: Partial<AgentConfig> | null = null

  constructor(emit: Emit, private settings: AdapterSettings) {
    super(emit, new ClaudeTranslator())
  }

  start(opts: StartOptions): void {
    this.cwd = opts.cwd
    this.config = { model: opts.model ?? '', effort: opts.effort ?? '' }
    // A saved session continues through the same --resume used for relaunches.
    this.sessionId = opts.resume?.id ?? ''
    this.emit({ kind: 'options', models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS })
    this.emit({ kind: 'config', config: this.config })
    this.launch()
  }

  send(text: string): void {
    this.busy = true
    this.emit({ kind: 'user-message', text })
    this.emit({ kind: 'turn-start' })
    this.write({ type: 'user', message: { role: 'user', content: text } })
  }

  /** Claude's stream-json mode has an `interrupt` control request. */
  abort(): void {
    this.write({ type: 'control_request', request_id: `abort-${Date.now()}`, request: { subtype: 'interrupt' } })
  }

  /**
   * Model and effort are CLI flags, so a change means relaunching with
   * --resume. Wait for the current turn to finish so no work is cut off.
   */
  configure(change: Partial<AgentConfig>): void {
    this.pending = { ...this.pending, ...change }
    if (this.busy) this.emit({ kind: 'notice', text: 'The new settings apply when the current turn finishes.' })
    else this.applyPending()
  }

  protected onRecord(rec: any): void {
    super.onRecord(rec)
    if (rec.type === 'system' && rec.subtype === 'init' && rec.session_id) this.sessionId = rec.session_id
    if (rec.type === 'result') {
      this.busy = false
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
