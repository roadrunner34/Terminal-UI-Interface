// Pure reducer from AgentEvents to UI state. Kept free of Svelte/Electron so
// it can be unit-tested directly against adapter output.
import {
  defaultConfig,
  scopeKey,
  type AgentConfig,
  type AgentEvent,
  type AgentId,
  type ModelOption,
  type SessionStats
} from './events'
import type { SessionSummary } from './api'

export type Block =
  | { type: 'user'; id: string; text: string }
  | { type: 'notice'; id: string; text: string }
  | { type: 'assistant'; id: string; text: string; thinking: string }
  | {
      type: 'tool'
      id: string
      name: string
      input: unknown
      output: string
      status: 'running' | 'done' | 'error'
    }

export interface Subagent {
  id: string
  label: string
  agentType: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  endedAt?: number
  /** Short description of the most recent activity, for the card. */
  lastActivity: string
  /** Model(s) the subagent runs on, once known ('' until reported). */
  model: string
}

export interface SessionState {
  agent: AgentId | null
  sessionId: string | null
  /** Model the agent reports it is actually using (e.g. a resolved full id). */
  model: string
  /** What the user selected; '' means the agent's default. */
  config: AgentConfig
  /** Choices advertised by the running agent, if any. */
  models: ModelOption[]
  efforts: string[]
  running: boolean
  busy: boolean
  /** Transcripts keyed by scope ('main' or subagent id). */
  transcripts: Record<string, Block[]>
  subagents: Record<string, Subagent>
  stats: SessionStats
  error: string | null
  /** The saved session being viewed (and possibly continued), if any. */
  replay: SessionSummary | null
}

export const emptyStats = (): SessionStats => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  contextUsed: 0,
  contextMax: 0,
  costUsd: 0
})

export const initialState = (): SessionState => ({
  agent: null,
  sessionId: null,
  model: '',
  config: defaultConfig(),
  models: [],
  efforts: [],
  running: false,
  busy: false,
  transcripts: { main: [] },
  subagents: {},
  stats: emptyStats(),
  error: null,
  replay: null
})

let userSeq = 0

/** Applies one event, mutating `s` in place (callers wrap in a store update). */
export function applyEvent(s: SessionState, e: AgentEvent, now = Date.now()): SessionState {
  switch (e.kind) {
    case 'session':
      // Adapters may report a session more than once (provisional, then
      // confirmed by the agent), so only overwrite with real values.
      s.agent = e.agent
      if (e.sessionId) s.sessionId = e.sessionId
      if (e.model) s.model = e.model
      s.running = true
      s.error = null
      break
    case 'options':
      if (e.models) s.models = e.models
      if (e.efforts) s.efforts = e.efforts
      break
    case 'config':
      Object.assign(s.config, stripUndefined(e.config))
      break
    case 'notice':
      blocks(s, 'main').push({ type: 'notice', id: `n${++userSeq}`, text: e.text })
      break
    case 'user-message': {
      const key = e.scope ? scopeKey(e.scope) : 'main'
      blocks(s, key).push({ type: 'user', id: `u${++userSeq}`, text: e.text })
      if (key === 'main') s.busy = true
      break
    }
    case 'turn-start':
      s.busy = true
      break
    case 'text-delta':
    case 'thinking-delta':
    case 'text': {
      const key = scopeKey(e.scope)
      const msg = assistant(s, key, e.messageId)
      if (e.kind === 'text') msg.text = e.text
      else if (e.kind === 'text-delta') msg.text += e.text
      else msg.thinking += e.text
      if (e.kind !== 'thinking-delta') touch(s, key, lastLine(msg.text))
      break
    }
    case 'tool-start': {
      const key = scopeKey(e.scope)
      const list = blocks(s, key)
      const existing = list.find((b) => b.type === 'tool' && b.id === e.toolId)
      if (existing && existing.type === 'tool') existing.input = e.input
      else
        list.push({ type: 'tool', id: e.toolId, name: e.name, input: e.input, output: '', status: 'running' })
      touch(s, key, `▸ ${e.name} ${summarizeInput(e.input)}`)
      break
    }
    case 'tool-update':
    case 'tool-end': {
      const key = scopeKey(e.scope)
      const tool = blocks(s, key).find((b) => b.type === 'tool' && b.id === e.toolId)
      if (tool && tool.type === 'tool') {
        tool.output = e.output
        if (e.kind === 'tool-end') tool.status = e.isError ? 'error' : 'done'
      }
      break
    }
    case 'subagent-start':
      s.subagents[e.subagentId] = {
        id: e.subagentId,
        label: e.label,
        agentType: e.agentType,
        status: 'running',
        startedAt: now,
        lastActivity: 'Starting…',
        model: ''
      }
      s.transcripts[e.subagentId] ??= []
      break
    case 'subagent-update': {
      const sub = s.subagents[e.subagentId]
      if (sub && e.model) sub.model = e.model
      if (sub && e.activity) sub.lastActivity = e.activity
      break
    }
    case 'subagent-end': {
      // Several sources may report the same ending; the first one wins.
      const sub = s.subagents[e.subagentId]
      if (sub && sub.status === 'running') {
        sub.status = e.status
        sub.endedAt = now
      }
      break
    }
    case 'stats':
      Object.assign(s.stats, stripUndefined(e.stats))
      break
    case 'turn-end':
      // Subagents are left alone: background runs (e.g. pi-subagents) keep
      // working after the turn ends; adapters end them explicitly.
      s.busy = false
      break
    case 'error':
      s.error = e.message
      break
    case 'exit':
      s.running = false
      s.busy = false
      break
  }
  return s
}

function blocks(s: SessionState, key: string): Block[] {
  return (s.transcripts[key] ??= [])
}

function assistant(s: SessionState, key: string, id: string) {
  const list = blocks(s, key)
  const found = list.find((b) => b.type === 'assistant' && b.id === id)
  if (found && found.type === 'assistant') return found
  const msg = { type: 'assistant' as const, id, text: '', thinking: '' }
  list.push(msg)
  return msg
}

function touch(s: SessionState, key: string, activity: string) {
  const sub = s.subagents[key]
  if (sub && activity) sub.lastActivity = activity
}

/** Latest line of text, with markdown punctuation stripped for card previews. */
function lastLine(text: string): string {
  const lines = text.trim().split('\n')
  return (lines[lines.length - 1] ?? '')
    .replace(/[*_`#>]+/g, '')
    .trim()
    .slice(0, 120)
}

export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.description ?? o.url ?? o.query
  return typeof v === 'string' ? v.slice(0, 80) : ''
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
