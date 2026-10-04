// How tool calls are shown: diffs for edits, a terminal for shell commands,
// and the agent's task checklist. DOM-free so tests can import it.
//
// Claude: Edit {file_path, old_string, new_string}, MultiEdit {file_path, edits},
//   Write {file_path, content}, Read {file_path, offset, limit}, Bash/PowerShell {command}.
// Pi: edit {path, edits: [{oldText, newText}]}, write {path, content},
//   read {path, offset, limit}, bash {command}.
import type { Block } from './session'

export interface DiffLine {
  op: ' ' | '-' | '+'
  text: string
}

export type ToolView =
  | { kind: 'edit'; path: string; hunks: DiffLine[][]; added: number; removed: number }
  | { kind: 'write'; path: string; content: string; lines: number }
  | { kind: 'bash'; command: string; description?: string }
  | { kind: 'read'; path: string; range?: string }
  | { kind: 'generic' }

const SHELL_TOOLS = new Set(['bash', 'powershell'])

export function toolView(name: string, input: unknown): ToolView {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, any>
  const tool = name.toLowerCase()
  const path = str(o.file_path) ?? str(o.path)

  if (path && (tool === 'edit' || tool === 'multiedit')) {
    const edits: { old: string; new: string }[] = Array.isArray(o.edits)
      ? o.edits.map((e: any) => ({ old: str(e?.old_string) ?? str(e?.oldText) ?? '', new: str(e?.new_string) ?? str(e?.newText) ?? '' }))
      : [{ old: str(o.old_string) ?? str(o.oldText) ?? '', new: str(o.new_string) ?? str(o.newText) ?? '' }]
    const hunks = edits.map((e) => lineDiff(e.old, e.new))
    const count = (op: DiffLine['op']) => hunks.flat().filter((l) => l.op === op).length
    return { kind: 'edit', path, hunks, added: count('+'), removed: count('-') }
  }
  if (path && tool === 'write' && typeof o.content === 'string')
    return { kind: 'write', path, content: o.content, lines: o.content ? o.content.split('\n').length : 0 }
  if (SHELL_TOOLS.has(tool) && typeof o.command === 'string')
    return { kind: 'bash', command: o.command, description: str(o.description) }
  if (path && tool === 'read') {
    const from = num(o.offset)
    const limit = num(o.limit)
    const range =
      from && limit ? `lines ${from}–${from + limit - 1}` : from ? `from line ${from}` : limit ? `first ${limit} lines` : undefined
    return { kind: 'read', path, range }
  }
  return { kind: 'generic' }
}

/** Above this many cells, skip the LCS table and show a plain replace. */
const MAX_DIFF_CELLS = 250_000

/** Line diff of two snippets via longest common subsequence. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a ? a.split('\n') : []
  const y = b ? b.split('\n') : []
  if (x.length * y.length > MAX_DIFF_CELLS)
    return [...x.map((text) => ({ op: '-' as const, text })), ...y.map((text) => ({ op: '+' as const, text }))]
  // lcs[i][j] = common length of x[i..] and y[j..]
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1))
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ op: ' ', text: x[i++] })
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: '-', text: x[i++] })
    else out.push({ op: '+', text: y[j++] })
  }
  while (i < x.length) out.push({ op: '-', text: x[i++] })
  while (j < y.length) out.push({ op: '+', text: y[j++] })
  return out
}

/** A diff line, or a marker standing in for a long unchanged run. */
export type ShownLine = DiffLine | { op: 'skip'; count: number }

/** Keeps `context` unchanged lines around each change and folds the rest. */
export function foldContext(lines: DiffLine[], context = 3): ShownLine[] {
  const near = lines.map((_, i) =>
    lines.slice(Math.max(0, i - context), i + context + 1).some((l) => l.op !== ' ')
  )
  const out: ShownLine[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].op !== ' ' || near[i]) {
      out.push(lines[i])
      continue
    }
    const last = out[out.length - 1]
    if (last?.op === 'skip') last.count++
    else out.push({ op: 'skip', count: 1 })
  }
  return out
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface AgentTask {
  id: string
  subject: string
  /** Present-tense label for the task in progress ("Running tests"). */
  activeForm?: string
  status: TaskStatus
}

/**
 * The agent's own checklist, rebuilt from its tool calls in order: Claude's
 * TaskCreate/TaskUpdate (ids come from "Task #N created"), or TodoWrite,
 * which replaces the whole list each time.
 */
export function taskList(blocks: Block[]): AgentTask[] {
  let tasks: AgentTask[] = []
  for (const b of blocks) {
    if (b.type !== 'tool' || b.status === 'error') continue
    const input = (b.input ?? {}) as Record<string, any>
    if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
      tasks = input.todos.map((t: any, i: number) => ({
        id: String(t?.id ?? i + 1),
        subject: String(t?.content ?? t?.subject ?? ''),
        activeForm: str(t?.activeForm),
        status: taskStatus(t?.status) ?? 'pending'
      }))
    } else if (b.name === 'TaskCreate' && b.status === 'done') {
      const id = /Task #(\w+)/.exec(b.output)?.[1]
      if (id && !tasks.some((t) => t.id === id))
        tasks.push({ id, subject: String(input.subject ?? ''), activeForm: str(input.activeForm), status: 'pending' })
    } else if (b.name === 'TaskUpdate' && input.taskId != null) {
      const task = tasks.find((t) => t.id === String(input.taskId))
      if (!task) continue
      if (input.status === 'deleted') tasks = tasks.filter((t) => t !== task)
      else {
        task.status = taskStatus(input.status) ?? task.status
        if (typeof input.subject === 'string') task.subject = input.subject
        if (typeof input.activeForm === 'string') task.activeForm = input.activeForm
      }
    }
  }
  return tasks
}

function taskStatus(s: unknown): TaskStatus | undefined {
  return s === 'pending' || s === 'in_progress' || s === 'completed' ? s : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
