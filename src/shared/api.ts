import type {
  AgentConfig,
  AgentEvent,
  AgentId,
  ClaudeSessionOptions,
  ImageAttachment,
  McpAction,
  ModelOption,
  PiSessionOptions,
  PromptAnswer,
  SendOptions,
  StartOptions
} from './events'

/** Choices known before a session starts (static lists from the adapter). */
export interface AgentOptions {
  models: ModelOption[]
  efforts: string[]
}

export interface AppSettings {
  defaultAgent: AgentId
  claudePath: string
  piPath: string
  /**
   * Claude Code --permission-mode used in auto mode (acceptEdits, auto,
   * bypassPermissions, …). Plan mode always uses `plan`.
   */
  permissionMode: string
  /**
   * `ask` shows tool approvals and agent questions in the app; `deny` refuses
   * anything that would need the user, as if nobody were there.
   */
  approvals: 'ask' | 'deny'
  /** Desktop notifications when the agent finishes or needs you while the window is in the background. */
  notifications: boolean
  /** Pi tool names that should be shown as subagents. */
  piSubagentTools: string[]
  /** Let Pi compact the conversation on its own as context fills (its default). */
  piAutoCompaction: boolean
  lastCwd: string
  /** Last model/effort/mode chosen per agent, restored on the next start. */
  agentConfig: Record<AgentId, AgentConfig>
  /** Last advanced options used per agent, restored in the setup form. */
  sessionOptions: { claude: ClaudeSessionOptions; pi: PiSessionOptions }
}

/** A session an agent saved to disk, as listed in the history. */
export interface SessionSummary {
  agent: AgentId
  /** The agent's own session id (what Claude's --resume takes). */
  id: string
  /** The session's JSONL file. */
  path: string
  cwd: string
  /** The session's name, or its first prompt. */
  title: string
  startedAt: number
  updatedAt: number
}

/**
 * Pi's instruction files: AGENTS.md in the project and in Pi's agent dir,
 * the project's .pi/APPEND_SYSTEM.md, and (read-only) any SYSTEM.md.
 */
export type PiContextFile = 'project-agents' | 'project-append' | 'global-agents' | 'project-system' | 'global-system'

export interface ContextFileInfo {
  which: PiContextFile
  path: string
  exists: boolean
  text: string
  readOnly: boolean
}

/** A Pi package from settings.json (user or project scope). */
export interface PiPackage {
  /** As written in settings: npm:…, git:…, https://…, or a path. */
  source: string
  scope: 'user' | 'project'
  kind: 'npm' | 'git' | 'local'
  /** The entry narrows which resources load (an object entry). */
  filtered: boolean
  /** Found on disk (npm packages only; others aren't checked). */
  installed: boolean
  name?: string
  version?: string
  description?: string
  /** Counts from the package's `pi` manifest. */
  resources?: Partial<Record<'extensions' | 'skills' | 'prompts' | 'themes', number>>
}

/** A change to Pi's packages, run as a `pi` command in main. `local` means this project only. */
export interface PiPackageOp {
  op: 'install' | 'remove' | 'update' | 'update-all'
  source?: string
  local?: boolean
}

export interface PiPackageSearchResult {
  name: string
  version: string
  description: string
  weeklyDownloads?: number
}

/** A line of output from a package command, then its exit code. */
export type PiOutput = { id: string; line: string } | { id: string; exit: number | null }

/** One replayed event, stamped with when it originally happened. */
export interface HistoryEvent {
  at: number
  event: AgentEvent
}

/** An agent event and the tab whose session produced it. */
export interface TabEvent {
  tab: string
  event: AgentEvent
}

/**
 * The API the preload script exposes to the renderer as `window.agentDeck`.
 * Session calls name the tab they're for; each tab runs its own agent.
 */
export interface AgentDeckApi {
  start(tab: string, opts: StartOptions): Promise<void>
  send(tab: string, text: string, images?: ImageAttachment[], opts?: SendOptions): Promise<void>
  abort(tab: string): Promise<void>
  /** Summarize the conversation to free context. */
  compact(tab: string): Promise<void>
  /** Drop messages queued for after the current turn. */
  clearQueue(tab: string): Promise<void>
  /** Ask for a context breakdown (arrives as a context-usage event). */
  contextUsage(tab: string): Promise<void>
  stopTask(tab: string, taskId: string): Promise<void>
  /** Act on an MCP server or refresh the list; answered with mcp events. */
  mcp(tab: string, action: McpAction, name?: string): Promise<void>
  /** Run a shell command for the user (Pi). */
  shell(tab: string, command: string): Promise<void>
  rename(tab: string, title: string): Promise<void>
  /** Asks where to save, then exports the session. False if cancelled. */
  exportSession(tab: string): Promise<boolean>
  fork(tab: string, entryId: string): Promise<void>
  rewind(tab: string, entryId: string): Promise<void>
  stop(tab: string): Promise<void>
  /** Change model, effort and/or mode; applied live or at the next safe point. */
  configure(tab: string, config: Partial<AgentConfig>): Promise<void>
  /** Accept the plan from a plan-mode turn and run it in auto mode. */
  approvePlan(tab: string): Promise<void>
  /** Answer a `prompt-request` the agent is waiting on. */
  answerPrompt(tab: string, id: string, answer: PromptAnswer): Promise<void>
  /** Model/effort choices for an agent before it is running. */
  getOptions(agent: AgentId): Promise<AgentOptions>
  pickDirectory(): Promise<string | null>
  /** A file to pass to the agent (MCP config, subagents file). */
  pickFile(kind: 'json'): Promise<string | null>
  /** One of Pi's instruction files for a project folder (one the app picked or runs in). */
  readContext(cwd: string, which: PiContextFile): Promise<ContextFileInfo>
  writeContext(cwd: string, which: PiContextFile, text: string): Promise<ContextFileInfo>
  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** Saved sessions from every agent for this project folder, newest first. */
  listSessions(cwd: string): Promise<SessionSummary[]>
  /** A saved session's transcript as normalized events, in original order. */
  loadSession(s: SessionSummary): Promise<HistoryEvent[]>
  /** Pi's installed packages; the project's too when `cwd` is a folder the app knows. */
  listPiPackages(cwd?: string): Promise<PiPackage[]>
  /** Starts a package command; its output arrives through onPiOutput. One at a time. */
  runPiPackage(op: PiPackageOp, cwd?: string): Promise<{ id: string } | { error: string }>
  onPiOutput(cb: (o: PiOutput) => void): () => void
  /** npm packages tagged pi-package. */
  searchPiPackages(query: string): Promise<PiPackageSearchResult[]>
  /** Restarts idle Pi tabs on their sessions so they load package changes; busy ones follow after their turn. */
  reloadPiTabs(): Promise<{ reloaded: number; later: number }>
  /** Files in the tab's session folder (relative paths), for @-mentions. */
  listFiles(tab: string): Promise<string[]>
  onEvent(cb: (tab: string, e: AgentEvent) => void): () => void
  /** A notification for this tab was clicked. */
  onFocusTab(cb: (tab: string) => void): () => void
}
