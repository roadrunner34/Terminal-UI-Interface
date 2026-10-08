// Per-session advanced options: checked in main before they become CLI flags,
// and the temp files that carry long text (appended system prompts).
import type { AgentConfig, AgentId, ClaudeSessionOptions, PiSessionOptions, SessionOptions, StartOptions } from '@shared/events'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/**
 * A model, effort and/or mode change from the renderer, checked: model and
 * effort become CLI flag values ('' means the default), and mode is one of
 * the two. Anything malformed is dropped.
 */
export function cleanConfigChange(raw: unknown): Partial<AgentConfig> {
  const o: any = raw && typeof raw === 'object' ? raw : {}
  const out: Partial<AgentConfig> = {}
  for (const k of ['model', 'effort'] as const) {
    if (o[k] === '') out[k] = ''
    else {
      const v = value(o[k])
      if (v) out[k] = v
    }
  }
  if (o.mode === 'auto' || o.mode === 'plan') out.mode = o.mode
  return out
}

/** A session id as Claude's --resume takes it (a uuid) or Pi's session header has it. */
const SESSION_ID = /^\w[\w.-]*$/

/**
 * The renderer's start request, checked: a known agent, flag values that
 * can't turn into other flags, and a well-formed saved session to continue.
 * Whether the folder and saved session are ones the app handed out is
 * checked in main. Returns an error to show instead when it isn't valid.
 */
export function cleanStartOptions(raw: unknown): StartOptions | { error: string } {
  const o: any = raw && typeof raw === 'object' ? raw : {}
  if (o.agent !== 'claude' && o.agent !== 'pi') return { error: 'Unknown agent.' }
  if (typeof o.cwd !== 'string' || !o.cwd) return { error: 'Choose a project folder first.' }
  const config = cleanConfigChange(o)
  const opts: StartOptions = { agent: o.agent, cwd: o.cwd, mode: config.mode ?? 'auto' }
  if (config.model) opts.model = config.model
  if (config.effort) opts.effort = config.effort
  if (o.resume !== undefined) {
    const r = o.resume
    const ok = r && typeof r === 'object' && typeof r.path === 'string' && typeof r.id === 'string' && (!r.id || SESSION_ID.test(r.id))
    if (!ok) return { error: 'That saved session is not valid.' }
    opts.resume = { id: r.id, path: r.path }
  }
  opts.advanced = cleanSessionOptions(o.agent, o.advanced)
  return opts
}

// Temp files live in a folder per run, <tmp>/agent-deck-<pid>-XXXXXX.
// mkdtemp makes it fresh, unguessable and owner-only (0o700), so on a shared
// /tmp nobody else can read the text or swap a file; the pid in the name lets
// a later run tell which folders a crashed run left behind.
const RUN_DIR = /^agent-deck-(\d+)-/
const DAY_MS = 24 * 60 * 60 * 1000
let runDir: string | null = null

function ownTempDir(): string {
  if (!runDir || !existsSync(runDir)) runDir = mkdtempSync(join(tmpdir(), `agent-deck-${process.pid}-`))
  return runDir
}

/** A temp file holding `content`, readable only by this user, removed by the returned function. */
export function tempFile(suffix: string, content: string): { path: string; remove(): void } {
  const path = join(ownTempDir(), `${randomUUID()}-${suffix}`)
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 })
  return { path, remove: () => rmSync(path, { force: true }) }
}

/** Removes this run's temp folder (on quit). */
export function removeTempFiles(): void {
  if (runDir) rmSync(runDir, { recursive: true, force: true })
  runDir = null
}

/** Whether a process with this id is running. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes temp folders left by runs that have ended (e.g. crashed), and files
 * from before per-run folders that are over a day old. Run at startup.
 */
export function sweepTempFiles(root = tmpdir(), alive = pidAlive, now = Date.now()): void {
  const list = (dir: string) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  const remove = (path: string) => {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // Still in use (Windows); a later run tries again.
    }
  }
  for (const name of list(root)) {
    const pid = Number(RUN_DIR.exec(name)?.[1])
    if (pid && pid !== process.pid && !alive(pid)) remove(join(root, name))
  }
  // Earlier versions wrote straight into <tmp>/agent-deck.
  const legacy = join(root, 'agent-deck')
  for (const name of list(legacy)) {
    const path = join(legacy, name)
    try {
      if (now - statSync(path).mtimeMs > DAY_MS) remove(path)
    } catch {
      // Gone already.
    }
  }
  try {
    rmdirSync(legacy)
  } catch {
    // Missing, or still holds a recent file.
  }
}
