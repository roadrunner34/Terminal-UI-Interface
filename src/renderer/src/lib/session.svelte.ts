// Reactive session state. The pure reducer mutates a $state proxy, so Svelte
// tracks exactly the fields each event touches.
import type { AgentEvent } from '@shared/events'
import { applyEvent, initialState } from '@shared/session'

export const session = $state(initialState())

/** Which transcript the main pane shows: 'main' or a subagent id. */
export const view = $state({ scope: 'main' })

export function handleEvent(e: AgentEvent) {
  applyEvent(session, e)
}

export function resetSession() {
  Object.assign(session, initialState())
  view.scope = 'main'
}
