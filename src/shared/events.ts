// The normalized event stream every agent adapter emits. The renderer only
// understands these shapes, so adding a new agent means writing one adapter.

export type AgentId = 'claude' | 'pi'

/** Where an event belongs: the main conversation or one subagent's transcript. */
export type Scope = 'main' | { subagentId: string }

export interface SessionStats {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  /** Tokens currently occupying the context window (last main-scope request). */
  contextUsed: number
  /** Model context window size; 0 when unknown. */
  contextMax: number
  costUsd: number
}

/** A model the user can pick. `id` is what the adapter passes to its agent. */
export interface ModelOption {
  id: string
  label: string
}

/**
 * How much the agent may do on its own. `plan` is read-only: it explores and
 * proposes a plan. `auto` lets it edit files and run tools.
 */
export type AgentMode = 'auto' | 'plan'

/** The user's chosen model, effort and mode; '' means the agent's own default. */
export interface AgentConfig {
  model: string
  effort: string
  mode: AgentMode
}

export const defaultConfig = (): AgentConfig => ({ model: '', effort: '', mode: 'auto' })

/** An image sent with a prompt, base64-encoded. */
export interface ImageAttachment {
  mimeType: string
  data: string
}

/** A slash command the agent accepts (built-in, custom, skill or extension). */
export interface SlashCommand {
  name: string
  description?: string
}

/** One of Claude's AskUserQuestion questions. */
export interface PromptQuestion {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
}

/** Something the agent is blocked on until the user answers. */
export type UserPrompt =
  /** A tool call that needs permission. `canAlways` offers "allow for this session". */
  | { type: 'tool-approval'; tool: string; input: unknown; description?: string; canAlways: boolean }
  | { type: 'questions'; questions: PromptQuestion[] }
  | { type: 'select'; title: string; options: string[] }
  | { type: 'confirm'; title: string; message?: string }
  | { type: 'input'; title: string; placeholder?: string; prefill?: string; multiline: boolean }

/** An MCP server the agent connected (or failed to). `status` is the agent's own word. */
export interface McpServer {
  name: string
  status: string
  /** Why it isn't connected, when the agent says. */
  error?: string
  /** The server's own version, once connected. */
  version?: string
  /** Where it's configured (user, project, plugin, claude.ai…), in the agent's words. */
  scope?: string
  source?: string
  /** stdio, http, sse, claudeai-proxy… Sign-out applies to http/sse only. */
  transport?: string
  tools?: { name: string; readOnly?: boolean }[]
  /** An action on it is waiting for the agent's answer. */
  busy?: boolean
}

/** What the user can ask of an MCP server. `status` refreshes the whole list. */
export type McpAction = 'status' | 'reconnect' | 'enable' | 'disable' | 'auth' | 'logout'

/** A request the agent is waiting to retry after a provider error. */
export interface RetryState {
  attempt: number
  /** Retries allowed for this failure; 0 when unknown. */
  max: number
  /** When the next attempt starts (epoch ms). */
  at: number
  reason: string
}

/** Context window use by category (Claude's get_context_usage). */
export interface ContextUsage {
  total: number
  max: number
  /** `kind` is the agent's own word: used, deferred (loaded on demand) or free. */
  categories: { name: string; tokens: number; kind: string }[]
}

/** The user's reply to a UserPrompt. `cancelled` dismisses any kind. */
export type PromptAnswer =
  | { allow: boolean; always?: boolean }
  /** Question text → chosen label(s), comma-separated for multi-select. */
  | { answers: Record<string, string> }
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }

export type AgentEvent =
  | { kind: 'session'; agent: AgentId; sessionId: string; model: string }
  /** The models and effort levels this agent supports right now. */
  | { kind: 'options'; models?: ModelOption[]; efforts?: string[] }
  /** The model/effort now in effect (after start or a change). */
  | { kind: 'config'; config: Partial<AgentConfig> }
  /** A one-line status note shown inline in the main transcript. */
  | { kind: 'notice'; text: string }
  /**
   * A prompt: the user's to the main session, or the task a subagent was given.
   * `entryId` names it to the adapter, for forking or restoring files from it.
   */
  | { kind: 'user-message'; text: string; scope?: Scope; images?: ImageAttachment[]; entryId?: string }
  /** The conversation now ends before this user message (after a fork). */
  | { kind: 'truncate'; entryId: string }
  /** Text to put back in the message box (e.g. the prompt a fork removed). */
  | { kind: 'draft'; text: string }
  /** The session's display name, as the agent reports it. */
  | { kind: 'title'; title: string }
  /** Where the context window goes, by category. */
  | { kind: 'context-usage'; usage: ContextUsage }
  /** The slash commands the agent accepts right now. */
  | { kind: 'commands'; commands: SlashCommand[] }
  | { kind: 'text-delta'; scope: Scope; messageId: string; text: string }
  | { kind: 'thinking-delta'; scope: Scope; messageId: string; text: string }
  /** Full assistant text for a message; replaces any streamed deltas. */
  | { kind: 'text'; scope: Scope; messageId: string; text: string }
  | { kind: 'tool-start'; scope: Scope; toolId: string; name: string; input: unknown }
  | { kind: 'tool-update'; scope: Scope; toolId: string; output: string }
  | { kind: 'tool-end'; scope: Scope; toolId: string; output: string; isError: boolean }
  /** `taskId` marks a background task the user can stop. */
  | { kind: 'subagent-start'; subagentId: string; label: string; agentType: string; taskId?: string }
  | { kind: 'subagent-end'; subagentId: string; status: 'done' | 'error' }
  /**
   * Live details for a subagent card. `model` may refine a requested alias to
   * the real id; `activity` replaces the card's one-line status.
   */
  | { kind: 'subagent-update'; subagentId: string; model?: string; activity?: string; taskId?: string }
  | { kind: 'stats'; stats: Partial<SessionStats> }
  /** The agent is waiting on the user; answered through `answerPrompt(id, …)`. */
  | { kind: 'prompt-request'; id: string; scope: Scope; prompt: UserPrompt }
  /** A prompt was answered, cancelled, or timed out. */
  | { kind: 'prompt-resolved'; id: string }
  /** A provider error; the agent retries after `delayMs`. */
  | { kind: 'retry'; attempt: number; max: number; delayMs: number; reason: string }
  /** The retry went through (or gave up, with an error event of its own). */
  | { kind: 'retry-end' }
  /** The conversation was summarized to free context. */
  | { kind: 'compacted'; auto: boolean; tokensBefore?: number; tokensAfter?: number }
  /** Messages queued to send once the current turn finishes, oldest first. */
  | { kind: 'queue'; messages: string[] }
  /** The agent's MCP servers and their status. */
  | { kind: 'mcp'; servers: McpServer[] }
  /** An action on this MCP server started (busy) or got its answer. */
  | { kind: 'mcp-busy'; name: string; busy: boolean }
  | { kind: 'turn-start' }
  | { kind: 'turn-end' }
  | { kind: 'error'; message: string }
  | { kind: 'exit'; code: number | null }

/**
 * Claude Code flags fixed for a session's life (changing one means a new
 * session). Paths and text go straight to the CLI, which runs without a shell.
 */
export interface ClaudeSessionOptions {
  /** Added to Claude's system prompt (via a temp file and --append-system-prompt-file). */
  appendSystemPrompt?: string
  /** --add-dir: more folders Claude may read and edit. */
  addDirs?: string[]
  /** --mcp-config: MCP config files. */
  mcpConfigs?: string[]
  /** --strict-mcp-config: only the servers in mcpConfigs. */
  strictMcp?: boolean
  /** --agents: a file defining custom subagents. */
  agentsFile?: string
  /** --max-budget-usd: stop once the session has cost this much. */
  maxBudgetUsd?: number
  /** --fallback-model: comma-separated models to try when the main one is overloaded. */
  fallbackModel?: string
  /** --allowedTools / --disallowedTools, as the CLI writes them (e.g. `Bash(git *) Edit`). */
  allowedTools?: string
  disallowedTools?: string
  /** --bare: no hooks, plugins, CLAUDE.md or OAuth; needs ANTHROPIC_API_KEY. */
  bare?: boolean
}

/** Pi flags fixed for a session's life. */
export interface PiSessionOptions {
  /** Added to Pi's system prompt (via a temp file and --append-system-prompt). */
  appendSystemPrompt?: string
  /** -e: extra extensions for this session only (npm:…, git:…, a path). */
  extensions?: string[]
  /** -nc: skip AGENTS.md/CLAUDE.md discovery. */
  noContextFiles?: boolean
  /** --no-mcp: no MCP servers this session. */
  noMcp?: boolean
  /** --tools / --exclude-tools: comma lists, `*` patterns allowed. Plan mode keeps its own tools. */
  tools?: string
  excludeTools?: string
}

export type SessionOptions = ClaudeSessionOptions | PiSessionOptions

export interface StartOptions {
  agent: AgentId
  cwd: string
  /** Model override passed to the agent CLI; '' or absent uses its default. */
  model?: string
  /** Effort/thinking level; '' or absent uses the agent's default. */
  effort?: string
  /** Plan (read-only) or auto; absent means auto. */
  mode?: AgentMode
  /** Continue a saved session instead of starting a fresh one. */
  resume?: { id: string; path: string }
  /** Per-session flags for this agent (see ClaudeSessionOptions, PiSessionOptions). */
  advanced?: SessionOptions
}

/** How a prompt sent mid-turn is delivered. */
export interface SendOptions {
  /** Hold it until the turn finishes, instead of steering the running turn. */
  followUp?: boolean
}

export function scopeKey(scope: Scope): string {
  return scope === 'main' ? 'main' : scope.subagentId
}
