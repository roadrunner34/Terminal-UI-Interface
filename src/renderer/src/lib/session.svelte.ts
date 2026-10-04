// Reactive session state. The pure reducer mutates a $state proxy, so Svelte
// tracks exactly the fields each event touches.
import type { SessionSummary } from '@shared/api'
import type { AgentEvent } from '@shared/events'
import { applyEvent, initialState, type Subagent } from '@shared/session'

export const session = $state(initialState())

/**
 * Which transcript the main pane shows ('main' or a subagent id), and which
 * subagent is hovered in either the transcript or the panel, so both can
 * highlight it together.
 */
export const view = $state({ scope: 'main', hovered: '' })

export function handleEvent(e: AgentEvent) {
  applyEvent(session, e)
}

export function resetSession() {
  Object.assign(session, initialState())
  view.scope = 'main'
  view.hovered = ''
}

/**
 * Show a saved session. Its events go through the same reducer as live ones,
 * stamped with their original times so card order and durations hold.
 */
export async function openHistory(summary: SessionSummary) {
  // List rows are $state proxies, which Electron's IPC can't clone.
  const events = await window.agentDeck.loadSession($state.snapshot(summary))
  resetSession()
  session.replay = summary
  for (const { at, event } of events) applyEvent(session, event, at)
}

export interface SubagentRow {
  sub: Subagent
  depth: number
  /** Short stable tag shown on the card and on the tool call that spawned it: "2", "3a". */
  tag: string
  /** Child status counts, for parents such as pi-subagents workflows. */
  children: { running: number; done: number; error: number } | null
}

// Workflow lanes have ids "<workflow id>/<lane>"; they nest under their
// workflow. Rows keep launch order so a card never moves when its status
// changes.
const rows = $derived.by(() => {
  const all = Object.values(session.subagents)
  const parentOf = (id: string) => {
    const cut = id.lastIndexOf('/')
    return cut > 0 && session.subagents[id.slice(0, cut)] ? id.slice(0, cut) : null
  }
  const out: SubagentRow[] = []
  const add = (parent: string | null, depth: number, prefix: string) => {
    const kids = all.filter((s) => parentOf(s.id) === parent).sort((a, b) => a.startedAt - b.startedAt)
    kids.forEach((sub, i) => {
      const tag = depth === 0 ? String(i + 1) : prefix + (i < 26 ? String.fromCharCode(97 + i) : `.${i + 1}`)
      const row: SubagentRow = { sub, depth, tag, children: null }
      out.push(row)
      const before = out.length
      add(sub.id, depth + 1, tag)
      const desc = out.slice(before).filter((r) => r.depth === depth + 1)
      if (desc.length) {
        row.children = { running: 0, done: 0, error: 0 }
        for (const r of desc) row.children[r.sub.status]++
      }
    })
  }
  add(null, 0, '')
  return out
})

const tags = $derived(Object.fromEntries(rows.map((r) => [r.sub.id, r.tag])))

export const deck = {
  get rows() {
    return rows
  },
  get tags(): Record<string, string> {
    return tags
  }
}
