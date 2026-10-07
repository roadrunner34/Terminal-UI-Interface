// Reactive session state, one per tab. The pure reducer mutates a $state
// proxy, so Svelte tracks exactly the fields each event touches.
//
// Components read `session` and `view`, which always point at the active
// tab, and call the agent through `agent`, which names that tab.
import type { AppSettings, SessionSummary } from '@shared/api'
import {
  defaultConfig,
  type AgentConfig,
  type AgentEvent,
  type AgentId,
  type ImageAttachment,
  type McpAction,
  type PromptAnswer,
  type SendOptions,
  type SessionOptions,
  type SlashCommand,
  type StartOptions
} from '@shared/events'
import { applyEvent, initialState, type SessionState, type Subagent } from '@shared/session'
import { taskList } from '@shared/tools'

/**
 * Which transcript the main pane shows ('main' or a subagent id), and which
 * subagent is hovered in either the transcript or the panel, so both can
 * highlight it together.
 */
export interface ViewState {
  scope: string
  hovered: string
}

/** The top bar's choices before a session starts. */
export interface SetupForm {
  agent: AgentId
  cwd: string
  draft: AgentConfig
  /** Per-session flags for each agent, kept apart so switching agent keeps both. */
  advanced: AppSettings['sessionOptions']
  starting: boolean
  /** Filled from saved settings yet (the first tab exists before they load). */
  seeded: boolean
}

export interface Tab {
  id: string
  state: SessionState
  view: ViewState
  form: SetupForm
  /** Unsent composer text, kept while another tab is in front. */
  draft: string
  /** The advanced options the running session started with (fixed until it ends). */
  started: SessionOptions
}

let tabSeq = 0
let formDefaults: Omit<SetupForm, 'starting'> = {
  agent: 'claude',
  cwd: '',
  draft: defaultConfig(),
  advanced: { claude: {}, pi: {} },
  seeded: false
}

const copyForm = (f: Omit<SetupForm, 'starting'>) => ({
  ...f,
  draft: { ...f.draft },
  advanced: structuredClone($state.snapshot(f.advanced))
})

function makeTab(): Tab {
  return {
    id: `tab-${++tabSeq}`,
    state: initialState(),
    view: { scope: 'main', hovered: '' },
    form: { ...copyForm(formDefaults), starting: false },
    draft: '',
    started: {}
  }
}

const first = makeTab()
export const tabs = $state({ list: [first], active: first.id })

export function activeTab(): Tab {
  return tabs.list.find((t) => t.id === tabs.active) ?? tabs.list[0]
}

/** New tabs start from the saved agent, folder and choices; unseeded ones catch up. */
export function seedForms(settings: AppSettings) {
  const agent = settings.defaultAgent
  formDefaults = {
    agent,
    cwd: settings.lastCwd,
    draft: { ...settings.agentConfig[agent] },
    advanced: settings.sessionOptions ?? { claude: {}, pi: {} },
    seeded: true
  }
  for (const t of tabs.list) if (!t.form.seeded) Object.assign(t.form, copyForm(formDefaults))
}

export function newTab() {
  const tab = makeTab()
  tabs.list.push(tab)
  tabs.active = tab.id
}

/** Closes a tab, ending its session; there is always at least one tab. */
export function closeTab(id: string) {
  const i = tabs.list.findIndex((t) => t.id === id)
  if (i < 0) return
  if (tabs.list[i].state.running) window.agentDeck.stop(id)
  tabs.list.splice(i, 1)
  if (!tabs.list.length) tabs.list.push(makeTab())
  if (tabs.active === id) tabs.active = tabs.list[Math.min(i, tabs.list.length - 1)].id
}

/** Close from the UI: a tab in the middle of a turn asks first. */
export function requestClose(id: string) {
  const tab = tabs.list.find((t) => t.id === id)
  if (tab?.state.busy && !confirm('The agent in this tab is still working. End the session and close it?')) return
  closeTab(id)
}

export function cycleTab(step: 1 | -1) {
  const i = tabs.list.findIndex((t) => t.id === tabs.active)
  tabs.active = tabs.list[(i + step + tabs.list.length) % tabs.list.length].id
}

/** Forwards reads and writes to whatever object `target()` returns now. */
function follow<T extends object>(target: () => T): T {
  return new Proxy({} as T, {
    get: (_, k) => Reflect.get(target(), k),
    set: (_, k, v) => Reflect.set(target(), k, v),
    has: (_, k) => Reflect.has(target(), k),
    ownKeys: () => Reflect.ownKeys(target()),
    getOwnPropertyDescriptor: (_, k) => {
      const d = Reflect.getOwnPropertyDescriptor(target(), k)
      return d && { ...d, configurable: true }
    }
  })
}

/** The active tab's session. */
export const session: SessionState = follow(() => activeTab().state)
/** The active tab's view. */
export const view: ViewState = follow(() => activeTab().view)

/** The agent API for the active tab. */
export const agent = {
  start: (opts: StartOptions) => window.agentDeck.start(tabs.active, opts),
  send: (text: string, images?: ImageAttachment[], opts?: SendOptions) => window.agentDeck.send(tabs.active, text, images, opts),
  abort: () => window.agentDeck.abort(tabs.active),
  compact: () => window.agentDeck.compact(tabs.active),
  clearQueue: () => window.agentDeck.clearQueue(tabs.active),
  contextUsage: () => window.agentDeck.contextUsage(tabs.active),
  stopTask: (taskId: string) => window.agentDeck.stopTask(tabs.active, taskId),
  mcp: (action: McpAction, name?: string) => window.agentDeck.mcp(tabs.active, action, name),
  shell: (command: string) => window.agentDeck.shell(tabs.active, command),
  rename: (title: string) => window.agentDeck.rename(tabs.active, title),
  exportSession: () => window.agentDeck.exportSession(tabs.active),
  fork: (entryId: string) => window.agentDeck.fork(tabs.active, entryId),
  rewind: (entryId: string) => window.agentDeck.rewind(tabs.active, entryId),
  stop: () => window.agentDeck.stop(tabs.active),
  configure: (change: Partial<AgentConfig>) => window.agentDeck.configure(tabs.active, change),
  approvePlan: () => window.agentDeck.approvePlan(tabs.active),
  answerPrompt: (id: string, answer: PromptAnswer) => window.agentDeck.answerPrompt(tabs.active, id, answer),
  listFiles: () => window.agentDeck.listFiles(tabs.active)
}

export function handleEvent(tab: string, e: AgentEvent) {
  const t = tabs.list.find((t) => t.id === tab)
  const state = t?.state
  // A closed tab's last events can still arrive; drop them.
  if (!state) return
  applyEvent(state, e)
  // A fork hands back the prompt it removed, ready to edit and resend.
  if (e.kind === 'draft') t.draft = e.text
  // Remember each agent's commands: Claude only lists them after the first prompt.
  if (e.kind === 'commands' && state.agent && e.commands.length) {
    try {
      localStorage.setItem(commandsKey(state.agent), JSON.stringify(e.commands))
    } catch {
      // Storage may be unavailable; the live list still works.
    }
  }
}

const commandsKey = (agent: AgentId) => `agentDeck.commands.${agent}`

/** The agent's slash commands: the live list, or the last one it reported. */
export function commandsFor(agent: AgentId | null): SlashCommand[] {
  if (session.commands.length || !agent) return session.commands
  try {
    const saved = JSON.parse(localStorage.getItem(commandsKey(agent)) ?? '[]')
    return Array.isArray(saved) ? saved : []
  } catch {
    return []
  }
}

/** Clears a tab (the active one by default) back to the setup screen. */
export function resetSession(tab: Tab = activeTab()) {
  Object.assign(tab.state, initialState())
  tab.view.scope = 'main'
  tab.view.hovered = ''
}

/**
 * Show a saved session in the active tab. Its events go through the same
 * reducer as live ones, stamped with their original times so card order and
 * durations hold.
 */
export async function openHistory(summary: SessionSummary) {
  // The tab it was opened from, even if another is in front once it loads.
  const tab = activeTab()
  // List rows are $state proxies, which Electron's IPC can't clone.
  const events = await window.agentDeck.loadSession($state.snapshot(summary))
  // The tab may have been closed, or started a session, while this loaded.
  if (!tabs.list.includes(tab) || tab.state.running) return
  resetSession(tab)
  tab.state.replay = summary
  for (const { at, event } of events) applyEvent(tab.state, event, at)
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
const tasks = $derived(taskList(session.transcripts.main))

export const deck = {
  get rows() {
    return rows
  },
  get tags(): Record<string, string> {
    return tags
  },
  /** The main agent's task checklist, if it keeps one. */
  get tasks() {
    return tasks
  }
}
