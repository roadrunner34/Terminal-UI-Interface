// Small display formatters, kept DOM-free so tests can import them.
import type { AgentMode, ClaudeSessionOptions, PiSessionOptions, SessionOptions } from './events'

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/**
 * Compact model name for tight spaces: drops the provider prefix, the
 * "claude-" family prefix and date stamps.
 * "claude-haiku-4-5-20251001" → "haiku-4-5", "anthropic/claude-opus-5-5" → "opus-5-5".
 */
export function shortModel(model: string): string {
  return model
    .split(',')
    .map((m) =>
      m
        .trim()
        .replace(VENDOR_PREFIX, '')
        .replace(/^claude-/, '')
        .replace(/-\d{8}$/, '')
    )
    .join(', ')
}

/**
 * Pi names models "provider/id" and routers report "vendor/model"; the first
 * segment adds noise on a card (the full id stays in the tooltip).
 */
const VENDOR_PREFIX = /^[\w.-]+\//

/** Context-window fill bands: green until 70%, amber until 90%, then red. */
export function contextLevel(pct: number): 'low' | 'mid' | 'high' {
  return pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low'
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** "just now", "5m ago", "3h ago", "Yesterday", then a date: when a saved session was last used. */
export function formatWhen(ms: number, now = Date.now()): string {
  const min = Math.floor((now - ms) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  if (min < 24 * 60 && new Date(ms).getDate() === new Date(now).getDate()) return `${Math.floor(min / 60)}h ago`
  const day = (d: number) => new Date(d).setHours(0, 0, 0, 0)
  // Rounded, so a daylight-saving day of 23 or 25 hours still counts as one.
  if (Math.round((day(now) - day(ms)) / 86_400_000) <= 1) return 'Yesterday'
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear()
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })
}

/** What "run the plan" sends when the agent has no approval step of its own. */
export const PLAN_APPROVAL = 'The plan is approved. Go ahead and implement it.'

export function describeMode(mode: AgentMode): string {
  return mode === 'plan'
    ? 'Plan mode: the agent explores and proposes a plan without changing files.'
    : 'Auto mode: the agent can edit files and run tools.'
}

/** How many advanced options are set, for "Advanced · 3 set". */
export function countSessionOptions(o: SessionOptions | undefined): number {
  return o ? Object.values(o).filter((v) => v !== undefined && v !== false && v !== '' && !(Array.isArray(v) && !v.length)).length : 0
}

/** A short summary of a running session's fixed options, e.g. "+2 dirs · $5 cap · bare". */
export function summarizeSessionOptions(o: SessionOptions | undefined): string {
  if (!o) return ''
  const c = o as ClaudeSessionOptions & PiSessionOptions
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
  return [
    c.appendSystemPrompt && '+prompt',
    c.addDirs?.length && `+${n(c.addDirs.length, 'dir')}`,
    c.mcpConfigs?.length && `${n(c.mcpConfigs.length, 'MCP config')}${c.strictMcp ? ' only' : ''}`,
    c.agentsFile && 'agents file',
    c.maxBudgetUsd && `$${c.maxBudgetUsd} cap`,
    c.fallbackModel && 'fallback',
    (c.allowedTools || c.disallowedTools) && 'tool rules',
    c.bare && 'bare',
    c.extensions?.length && `+${n(c.extensions.length, 'extension')}`,
    c.noContextFiles && 'no AGENTS.md',
    c.noMcp && 'no MCP',
    (c.tools || c.excludeTools) && 'tool filter'
  ]
    .filter(Boolean)
    .join(' · ')
}
