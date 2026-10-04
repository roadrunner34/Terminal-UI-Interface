import type { AgentConfig, AgentEvent, AgentId, ImageAttachment, ModelOption, PromptAnswer, StartOptions } from './events'

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
  lastCwd: string
  /** Last model/effort/mode chosen per agent, restored on the next start. */
  agentConfig: Record<AgentId, AgentConfig>
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
  send(tab: string, text: string, images?: ImageAttachment[]): Promise<void>
  abort(tab: string): Promise<void>
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
  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** Saved sessions from every agent for this project folder, newest first. */
  listSessions(cwd: string): Promise<SessionSummary[]>
  /** A saved session's transcript as normalized events, in original order. */
  loadSession(s: SessionSummary): Promise<HistoryEvent[]>
  /** Files in the tab's session folder (relative paths), for @-mentions. */
  listFiles(tab: string): Promise<string[]>
  onEvent(cb: (tab: string, e: AgentEvent) => void): () => void
  /** A notification for this tab was clicked. */
  onFocusTab(cb: (tab: string) => void): () => void
}
