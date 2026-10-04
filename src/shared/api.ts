import type { AgentConfig, AgentEvent, AgentId, ModelOption, StartOptions } from './events'

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

/** The API the preload script exposes to the renderer as `window.agentDeck`. */
export interface AgentDeckApi {
  start(opts: StartOptions): Promise<void>
  send(text: string): Promise<void>
  abort(): Promise<void>
  stop(): Promise<void>
  /** Change model, effort and/or mode; applied live or at the next safe point. */
  configure(config: Partial<AgentConfig>): Promise<void>
  /** Accept the plan from a plan-mode turn and run it in auto mode. */
  approvePlan(): Promise<void>
  /** Model/effort choices for an agent before it is running. */
  getOptions(agent: AgentId): Promise<AgentOptions>
  pickDirectory(): Promise<string | null>
  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** Saved sessions from every agent for this project folder, newest first. */
  listSessions(cwd: string): Promise<SessionSummary[]>
  /** A saved session's transcript as normalized events, in original order. */
  loadSession(s: SessionSummary): Promise<HistoryEvent[]>
  onEvent(cb: (e: AgentEvent) => void): () => void
}
