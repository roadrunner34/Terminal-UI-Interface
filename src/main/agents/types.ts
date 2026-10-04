import type { AgentConfig, AgentEvent, StartOptions } from '@shared/events'

export interface AgentAdapter {
  start(opts: StartOptions): void
  send(text: string): void
  abort(): void
  /** Change model/effort. Adapters apply it live or at the next safe point. */
  configure(config: Partial<AgentConfig>): void
  dispose(): void
}

export type Emit = (e: AgentEvent) => void

/**
 * Converts one parsed JSONL record from an agent into normalized events.
 * Translators hold protocol state (open subagents, message ids) but no I/O,
 * so tests can feed them recorded fixtures directly.
 */
export interface Translator {
  handle(rec: any): AgentEvent[]
}

export interface AdapterSettings {
  claudePath: string
  piPath: string
  permissionMode: string
  piSubagentTools: string[]
}
