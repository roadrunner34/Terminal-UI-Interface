import type { HistoryEvent, SessionSummary } from '@shared/api'
import { listClaude, loadClaude } from './claude'
import { listPi, loadPi } from './pi'

/** Both agents' saved sessions for a folder, most recently used first. */
export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  if (!cwd) return []
  const [claude, pi] = await Promise.all([listClaude(cwd), listPi(cwd)])
  return [...claude, ...pi].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function loadSession(s: SessionSummary, piSubagentTools: string[]): Promise<HistoryEvent[]> {
  return s.agent === 'claude' ? loadClaude(s.path) : loadPi(s.path, piSubagentTools)
}
