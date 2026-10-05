import type { AgentConfig, AgentEvent, ImageAttachment, PromptAnswer, SendOptions, StartOptions } from '@shared/events'

export interface AgentAdapter {
  start(opts: StartOptions): void
  send(text: string, images?: ImageAttachment[], opts?: SendOptions): void
  abort(): void
  /** Summarize the conversation so far to free context. */
  compact(): void
  /** Drop messages queued for after the turn; they come back as a notice. */
  clearQueue(): void
  /** Ask for a context breakdown; answered with a context-usage event. */
  contextUsage(): void
  /** Stop a background task (see subagent-start's taskId). */
  stopTask(taskId: string): void
  /** Run a shell command for the user; its output joins the context. */
  shell(command: string): void
  /** Give the session a display name. */
  rename(title: string): void
  /** Save the session to `path` (HTML for Pi, the JSONL transcript for Claude). */
  exportSession(path: string): void
  /** Branch from before this user message; its text comes back as a draft. */
  fork(entryId: string): void
  /** Put files back as they were before this user message (asks first). */
  rewind(entryId: string): void
  /** Change model/effort. Adapters apply it live or at the next safe point. */
  configure(config: Partial<AgentConfig>): void
  /** Accept the plan from a plan-mode turn: switch to auto and carry it out. */
  approvePlan(): void
  /** Reply to a prompt-request this adapter emitted. Unknown ids are ignored. */
  answerPrompt(id: string, answer: PromptAnswer): void
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
  approvals: 'ask' | 'deny'
  piSubagentTools: string[]
  /** Pi compacts on its own as context fills; false turns that off. */
  piAutoCompaction: boolean
}
