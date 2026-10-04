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
  /** Claude Code --permission-mode (default, acceptEdits, plan, bypassPermissions). */
  permissionMode: string
  /** Pi tool names that should be shown as subagents. */
  piSubagentTools: string[]
  lastCwd: string
  /** Last model/effort chosen per agent, restored on the next start. */
  agentConfig: Record<AgentId, AgentConfig>
}

/** The API the preload script exposes to the renderer as `window.agentDeck`. */
export interface AgentDeckApi {
  start(opts: StartOptions): Promise<void>
  send(text: string): Promise<void>
  abort(): Promise<void>
  stop(): Promise<void>
  /** Change model and/or effort; applied live or at the next safe point. */
  configure(config: Partial<AgentConfig>): Promise<void>
  /** Model/effort choices for an agent before it is running. */
  getOptions(agent: AgentId): Promise<AgentOptions>
  pickDirectory(): Promise<string | null>
  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  onEvent(cb: (e: AgentEvent) => void): () => void
}
