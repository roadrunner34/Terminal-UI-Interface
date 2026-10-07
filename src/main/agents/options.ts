// Per-session advanced options: checked in main before they become CLI flags,
// and the temp files that carry long text (appended system prompts).
import type { AgentId, ClaudeSessionOptions, PiSessionOptions, SessionOptions } from '@shared/events'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_TEXT = 20_000
const MAX_ITEM = 1_000
const MAX_ITEMS = 20

/** A flag value: trimmed, and never one the CLI would read as another flag. */
function value(v: unknown, max = MAX_ITEM): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t && !t.startsWith('-') && t.length <= max ? t : undefined
}

function list(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const items = v.map((x) => value(x)).filter((x): x is string => !!x).slice(0, MAX_ITEMS)
  return items.length ? items : undefined
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= MAX_TEXT ? v : undefined
}

function flag(v: unknown): true | undefined {
  return v === true ? true : undefined
}

function prune<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/** Keeps only well-formed options for `agent`; anything else is dropped. */
export function cleanSessionOptions(agent: AgentId, raw: unknown): SessionOptions {
  const o: any = raw && typeof raw === 'object' ? raw : {}
  if (agent === 'claude') {
    const budget = Number(o.maxBudgetUsd)
    const c: ClaudeSessionOptions = {
      appendSystemPrompt: text(o.appendSystemPrompt),
      addDirs: list(o.addDirs),
      mcpConfigs: list(o.mcpConfigs),
      agentsFile: value(o.agentsFile),
      maxBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
      fallbackModel: value(o.fallbackModel),
      allowedTools: value(o.allowedTools),
      disallowedTools: value(o.disallowedTools),
      bare: flag(o.bare)
    }
    // Only meaningful with configs of its own; alone it would drop every server.
    if (c.mcpConfigs) c.strictMcp = flag(o.strictMcp)
    return prune(c)
  }
  const p: PiSessionOptions = {
    appendSystemPrompt: text(o.appendSystemPrompt),
    extensions: list(o.extensions),
    noContextFiles: flag(o.noContextFiles),
    noMcp: flag(o.noMcp),
    tools: value(o.tools),
    excludeTools: value(o.excludeTools)
  }
  return prune(p)
}

/** A temp file holding `content`, removed by the returned function. */
export function tempFile(suffix: string, content: string): { path: string; remove(): void } {
  const dir = join(tmpdir(), 'agent-deck')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${randomUUID()}-${suffix}`)
  writeFileSync(path, content, 'utf8')
  return { path, remove: () => rmSync(path, { force: true }) }
}
