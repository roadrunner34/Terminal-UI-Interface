// Composer autocomplete: `/command` at the start of a message, `@path`
// anywhere. DOM-free so tests can import it.
import type { SlashCommand } from './events'

export interface Token {
  kind: 'command' | 'file'
  /** What's typed after the trigger character. */
  query: string
  /** Range of the whole token (trigger included) in the text. */
  start: number
  end: number
}

/** The completable token ending at the caret, if any. */
export function tokenAt(text: string, caret: number): Token | null {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  const word = text.slice(start, caret)
  // Commands only make sense as the whole message's first word.
  if (word.startsWith('/') && start === 0) return { kind: 'command', query: word.slice(1), start, end: caret }
  if (word.startsWith('@')) return { kind: 'file', query: word.slice(1), start, end: caret }
  return null
}

export interface Suggestion {
  /** What replaces the token. */
  value: string
  label: string
  detail?: string
}

export function suggestCommands(commands: SlashCommand[], query: string, max = 8): Suggestion[] {
  const q = query.toLowerCase()
  const score = (name: string) => {
    const n = name.toLowerCase()
    if (n.startsWith(q)) return 0
    // Plugin commands are "plugin:name"; match the part after the colon too.
    if (n.split(':').pop()!.startsWith(q)) return 1
    return n.includes(q) ? 2 : -1
  }
  return commands
    .map((c) => ({ c, s: score(c.name) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name))
    .slice(0, max)
    .map(({ c }) => ({ value: `/${c.name}`, label: `/${c.name}`, detail: c.description && firstSentence(c.description) }))
}

/**
 * Files ranked by how well they match: file name first, then path, then a
 * loose in-order match ("srcses" finds "src/shared/session.ts").
 */
export function suggestFiles(files: string[], query: string, max = 8): Suggestion[] {
  const q = query.toLowerCase()
  const scored: { f: string; s: number }[] = []
  for (const f of files) {
    const path = f.toLowerCase()
    const name = path.slice(path.lastIndexOf('/') + 1)
    let s = -1
    if (!q) s = 3
    else if (name.startsWith(q)) s = 0
    else if (name.includes(q)) s = 1
    else if (path.includes(q)) s = 2
    else if (subsequence(q, path)) s = 4
    if (s >= 0) scored.push({ f, s })
  }
  // Loose matches are a fallback: next to real ones they're mostly noise.
  const strong = scored.some((x) => x.s < 4)
  // Ties: the shorter file name is the closer match, then the shallower path.
  const nameLength = (f: string) => f.length - f.lastIndexOf('/')
  return scored
    .filter((x) => !strong || x.s < 4)
    .sort((a, b) => a.s - b.s || nameLength(a.f) - nameLength(b.f) || a.f.length - b.f.length || a.f.localeCompare(b.f))
    .slice(0, max)
    .map(({ f }) => {
      const cut = f.lastIndexOf('/')
      return { value: `@${/\s/.test(f) ? `"${f}"` : f}`, label: f.slice(cut + 1), detail: cut > 0 ? f.slice(0, cut) : undefined }
    })
}

/** Replaces the token with the chosen value plus a space; returns the new text and caret. */
export function applyCompletion(text: string, token: Token, value: string): { text: string; caret: number } {
  const after = text.slice(token.end)
  const insert = after.startsWith(' ') ? value : `${value} `
  return { text: text.slice(0, token.start) + insert + after, caret: token.start + insert.length }
}

function subsequence(q: string, s: string): boolean {
  let i = 0
  for (const ch of s) if (ch === q[i] && ++i === q.length) return true
  return i === q.length
}

function firstSentence(s: string): string {
  const one = s.split(/(?<=\.)\s/)[0]
  return one.length > 90 ? `${one.slice(0, 89)}…` : one
}
