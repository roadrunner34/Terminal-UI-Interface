// Pi saves each session as <sessions>/--<encoded cwd>--/<timestamp>_<id>.jsonl:
// a `session` header, then `message` entries holding the conversation
// (see pi-coding-agent docs/session-format.md).
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HistoryEvent, SessionSummary } from '@shared/api'
import type { AgentEvent } from '@shared/events'
import { contentText, describeSubagent, isLaunch } from '../agents/pi'
import { listDir, oneLine, readRecords, samePath, time } from './files'

export function piSessionsRoot(): string {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions')
}

/** "D:\a b" → "--D--a b--", "D:\" → "--D----": separators and the drive colon become '-'. */
export function piProjectName(cwd: string): string {
  return `--${cwd.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`
}

export async function listPi(cwd: string, root = piSessionsRoot()): Promise<SessionSummary[]> {
  const want = piProjectName(cwd).toLowerCase()
  const dirs = (await listDir(root)).filter((d) => d.toLowerCase() === want)
  const out: SessionSummary[] = []
  for (const dir of dirs) {
    for (const file of await listDir(join(root, dir))) {
      if (!file.endsWith('.jsonl')) continue
      const s = await summarize(join(root, dir, file), cwd).catch(() => null)
      if (s) out.push(s)
    }
  }
  return out
}

async function summarize(path: string, cwd: string): Promise<SessionSummary | null> {
  const recs = await readRecords(path)
  const header = recs.find((r) => r.type === 'session')
  if (!header || (header.cwd && !samePath(header.cwd, cwd))) return null
  let name = ''
  let prompt = ''
  for (const r of recs) {
    if (r.type === 'session_info' && r.name) name = r.name
    if (!prompt && r.type === 'message' && r.message?.role === 'user') prompt = userText(r.message.content)
  }
  if (!prompt) return null
  const updatedAt = (await stat(path)).mtimeMs
  return {
    agent: 'pi',
    id: header.id ?? '',
    path,
    cwd,
    title: oneLine(name || prompt),
    startedAt: time(header.timestamp) || updatedAt,
    updatedAt
  }
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((c: any) => c?.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
    .trim()
}

export async function loadPi(path: string, subagentTools: string[]): Promise<HistoryEvent[]> {
  return replayPi(await readRecords(path), new Set(subagentTools))
}

/** Pure replay of saved Pi entries, separate from file I/O for tests. */
export function replayPi(recs: any[], subagentTools: Set<string>): HistoryEvent[] {
  const out: HistoryEvent[] = []
  const subagents = new Set<string>()
  let at = 0
  const push = (event: AgentEvent) => out.push({ at, event })

  for (const r of recs) {
    if (r.type !== 'message') continue
    at = time(r.timestamp) || at
    const m = r.message ?? {}
    if (m.role === 'user') {
      const text = userText(m.content)
      if (text) push({ kind: 'user-message', text })
    } else if (m.role === 'assistant') {
      const messageId = `pi-${r.id}`
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === 'text' && c.text) push({ kind: 'text-delta', scope: 'main', messageId, text: c.text })
        else if (c?.type === 'thinking' && c.thinking)
          push({ kind: 'thinking-delta', scope: 'main', messageId, text: c.thinking })
        else if (c?.type === 'toolCall') {
          push({ kind: 'tool-start', scope: 'main', toolId: c.id, name: c.name, input: c.arguments })
          if (subagentTools.has(c.name) && isLaunch(c.arguments)) {
            subagents.add(c.id)
            push({ kind: 'subagent-start', subagentId: c.id, ...describeSubagent(c.arguments) })
          }
        }
      }
      const u = m.usage
      if (u) {
        const contextUsed = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0)
        if (contextUsed > 0) push({ kind: 'stats', stats: { contextUsed } })
      }
    } else if (m.role === 'toolResult') {
      const id: string = m.toolCallId
      const text = contentText(m)
      const isError = !!m.isError
      push({ kind: 'tool-end', scope: 'main', toolId: id, output: text, isError })
      if (subagents.delete(id)) {
        push({ kind: 'text', scope: { subagentId: id }, messageId: `${id}-out`, text })
        if (m.details?.asyncId) push({ kind: 'subagent-update', subagentId: id, activity: 'Ran in the background' })
        push({ kind: 'subagent-end', subagentId: id, status: isError ? 'error' : 'done' })
      }
    }
  }
  for (const id of subagents) {
    push({ kind: 'subagent-update', subagentId: id, activity: 'No result recorded' })
    push({ kind: 'subagent-end', subagentId: id, status: 'error' })
  }
  push({ kind: 'turn-end' })
  return out
}
