import type { AgentOptions } from '@shared/api'
import type { AgentId } from '@shared/events'
import { CLAUDE_EFFORTS, CLAUDE_MODELS, ClaudeAdapter } from './claude'
import { PiAdapter } from './pi'
import type { AdapterSettings, AgentAdapter, Emit } from './types'

/** Add new agents here: one adapter class per CLI protocol. */
export function createAdapter(agent: AgentId, emit: Emit, settings: AdapterSettings): AgentAdapter {
  switch (agent) {
    case 'claude':
      return new ClaudeAdapter(emit, settings)
    case 'pi':
      return new PiAdapter(emit, settings)
    default:
      throw new Error(`Unknown agent: ${agent satisfies never}`)
  }
}

/**
 * Choices shown before a session starts. Pi's list depends on the user's
 * configured providers, so it is only known once Pi is running.
 */
export function staticOptions(agent: AgentId): AgentOptions {
  return agent === 'claude' ? { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS } : { models: [], efforts: [] }
}
