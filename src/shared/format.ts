// Small display formatters, kept DOM-free so tests can import them.

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

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
