// Claude Code saves each session as ~/.claude/projects/<encoded cwd>/<id>.jsonl.
// Saved `user`/`assistant` records have the same shape as stream-json output,
// so replay reuses the live ClaudeTranslator. Subagent transcripts live
// beside it in <id>/subagents/agent-*.jsonl, each with a .meta.json naming
// the Agent tool_use id that launched it (our subagent id).
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { HistoryEvent, SessionSummary } from '@shared/api'
import type { AgentEvent } from '@shared/events'
import { ClaudeTranslator } from '../agents/claude'
import { listDir, oneLine, readRecords, samePath, time } from './files'

export function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** Claude names a project folder after its cwd with every non-alphanumeric as '-'. */
export function claudeProjectName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export async function listClaude(cwd: string, root = claudeRoot()): Promise<SessionSummary[]> {
  const projects = join(root, 'projects')
  // Drive letters are saved in either case ("D--x" and "d--x").
  const want = claudeProjectName(cwd).toLowerCase()
  const dirs = (await listDir(projects)).filter((d) => d.toLowerCase() === want)
  const out: SessionSummary[] = []
  for (const dir of dirs) {
    for (const file of await listDir(join(projects, dir))) {
      if (!file.endsWith('.jsonl')) continue
      const s = await summarize(join(projects, dir, file), cwd).catch(() => null)
      if (s) out.push(s)
    }
  }
  return out
}

async function summarize(path: string, cwd: string): Promise<SessionSummary | null> {
  const recs = await readRecords(path)
  let prompt = ''
  let startedAt = 0
  let aiTitle = ''
  let customTitle = ''
  let recCwd = ''
  for (const r of recs) {
    if (r.type === 'custom-title' && r.customTitle) customTitle = r.customTitle
    // Later ai-titles can be kebab-case slugs ("browse-resume-sessions");
    // keep the last one written as words.
    else if (r.type === 'ai-title' && /\s/.test(r.aiTitle ?? '')) aiTitle = r.aiTitle
    if (!recCwd && typeof r.cwd === 'string') recCwd = r.cwd
    if (r.type === 'user' && (!prompt || prompt.startsWith('/'))) {
      const text = promptText(r)
      if (text && !startedAt) startedAt = time(r.timestamp)
      // "/clear" or "/model" says little; a later typed prompt names it better.
      if (text && (!prompt || !text.startsWith('/'))) prompt = text
    }
  }
  // Sessions that never got a prompt (e.g. opened and closed) aren't worth listing.
  if (!prompt) return null
  // Different folders can encode to the same name ("a b" and "a-b").
  if (recCwd && !samePath(recCwd, cwd)) return null
  const updatedAt = (await stat(path)).mtimeMs
  return {
    agent: 'claude',
    id: basename(path, '.jsonl'),
    path,
    cwd,
    title: oneLine(customTitle || aiTitle || prompt),
    startedAt: startedAt || updatedAt,
    updatedAt
  }
}

/**
 * What the user typed, from a saved user record, or '' for tool results and
 * text Claude Code injected itself (hook output, task notifications, …).
 * Slash commands are saved as tags; show them as typed.
 */
export function promptText(rec: any): string {
  if (rec.isMeta) return ''
  const content = rec.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content) && !content.some((c: any) => c?.type === 'tool_result'))
    text = content
      .filter((c: any) => c?.type === 'text')
      .map((c: any) => c.text)
      .join('\n')
  text = text.trim()
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? ''
    return `${command[1]} ${args}`.trim()
  }
  return /^<[a-z-]+>/.test(text) ? '' : text
}

export async function loadClaude(path: string): Promise<HistoryEvent[]> {
  const out: HistoryEvent[] = []
  const translator = new ClaudeTranslator()
  /** Main-file subagent endings, held back when the subagent has its own file. */
  const ends = new Map<string, { at: number; event: AgentEvent }>()
  let at = 0

  for (const rec of await readRecords(path)) {
    if (rec.type !== 'user' && rec.type !== 'assistant') continue
    at = time(rec.timestamp) || at
    if (rec.type === 'user') {
      const text = promptText(rec)
      if (text) out.push({ at, event: { kind: 'user-message', text } })
    }
    for (const event of translator.handle(rec)) {
      if (event.kind === 'subagent-end') ends.set(event.subagentId, { at, event })
      else out.push({ at, event })
    }
  }

  // Background subagents return from the Agent call right away, so their
  // card should end with their own transcript, not with that call.
  const dir = join(path.replace(/\.jsonl$/, ''), 'subagents')
  for (const file of await listDir(dir)) {
    if (!file.endsWith('.meta.json')) continue
    const meta = (await readRecords(join(dir, file)))[0]
    const id: string | undefined = meta?.toolUseId
    if (!id || !out.some((h) => h.event.kind === 'subagent-start' && h.event.subagentId === id)) continue
    const recs = await readRecords(join(dir, file.replace(/\.meta\.json$/, '.jsonl'))).catch(() => [])
    const last = await replaySubagent(id, recs, out)
    const end = ends.get(id)
    if (end && last) end.at = Math.max(end.at, last)
  }
  for (const end of ends.values()) out.push(end)
  // Nothing recorded an ending (the session was closed mid-turn).
  for (const { event } of [...out]) {
    if (event.kind !== 'subagent-start' || ends.has(event.subagentId)) continue
    out.push({ at, event: { kind: 'subagent-update', subagentId: event.subagentId, activity: 'No result recorded' } })
    out.push({ at, event: { kind: 'subagent-end', subagentId: event.subagentId, status: 'error' } })
  }

  // A replay is idle: no turn is in progress.
  out.push({ at, event: { kind: 'turn-end' } })
  return out
}

/**
 * Replays one subagent file into its card. Returns when it last replied:
 * later user records (e.g. a message sent to it hours afterwards) aren't work.
 */
async function replaySubagent(id: string, recs: any[], out: HistoryEvent[]): Promise<number> {
  const translator = new ClaudeTranslator()
  let at = 0
  let replied = 0
  let model = ''
  for (const rec of recs) {
    if (rec.type !== 'user' && rec.type !== 'assistant') continue
    at = time(rec.timestamp) || at
    if (rec.type === 'assistant') replied = at
    const scoped = { ...rec, parent_tool_use_id: id }
    if (rec.type === 'user') {
      const text = promptText(rec)
      if (text) out.push({ at, event: { kind: 'user-message', text, scope: { subagentId: id } } })
    }
    if (!model && rec.type === 'assistant' && typeof rec.message?.model === 'string') {
      model = rec.message.model
      out.push({ at, event: { kind: 'subagent-update', subagentId: id, model } })
    }
    for (const event of translator.handle(scoped)) out.push({ at, event })
  }
  return replied
}
