// What deserves a desktop notification while the window is in the background:
// the agent needs the user (approval, question, plan), finished, or failed.
// Pure, so tests can feed it events; index.ts shows the result.
import type { AgentEvent, AgentId, AgentMode } from '@shared/events'
import { summarizeInput } from '@shared/session'

export interface Notice {
  title: string
  body: string
  /** Needs an answer, not just news: also flash the taskbar button. */
  urgent: boolean
}

const NAMES: Record<AgentId, string> = { claude: 'Claude Code', pi: 'Pi' }

export class Notifier {
  private mode: AgentMode = 'auto'
  private lastId = ''
  private lastText = ''

  constructor(private agent: () => AgentId | null) {}

  /** Follows the stream; returns a notice for events worth one. */
  handle(e: AgentEvent): Notice | null {
    const name = NAMES[this.agent() ?? 'claude']
    switch (e.kind) {
      case 'config':
        if (e.config.mode) this.mode = e.config.mode
        return null
      case 'user-message':
        if (!e.scope || e.scope === 'main') this.lastText = ''
        return null
      case 'text':
      case 'text-delta':
        if (e.scope !== 'main') return null
        if (e.kind === 'text' || e.messageId !== this.lastId) this.lastText = ''
        this.lastId = e.messageId
        this.lastText += e.text
        return null
      case 'prompt-request': {
        const p = e.prompt
        if (p.type === 'tool-approval')
          return { title: `${name} needs your approval`, body: `${p.tool}: ${summarizeInput(p.input) || p.description || 'tool call'}`, urgent: true }
        if (p.type === 'questions') return { title: `${name} has a question`, body: p.questions[0]?.question ?? '', urgent: true }
        return { title: `${name} needs your input`, body: p.title, urgent: true }
      }
      case 'turn-end':
        if (this.mode === 'plan') return { title: `${name}: plan ready`, body: 'Run it, or reply to refine it.', urgent: true }
        return { title: `${name} finished`, body: lastLine(this.lastText) || 'Your turn.', urgent: false }
      case 'error':
        return { title: `${name} hit an error`, body: e.message.slice(0, 200), urgent: false }
      case 'exit':
        return e.code ? { title: `${name} stopped`, body: `It exited with code ${e.code}.`, urgent: false } : null
      default:
        return null
    }
  }
}

function lastLine(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim()).pop() ?? ''
  const plain = line.replace(/[*_`#>]+/g, '').trim()
  return plain.length > 140 ? `${plain.slice(0, 139)}…` : plain
}
