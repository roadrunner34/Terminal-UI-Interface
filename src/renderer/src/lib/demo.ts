// Browser-only stand-in for the Electron preload API. Loaded when the
// renderer runs outside Electron (e.g. `vite` preview) so the UI can be
// developed and reviewed without spawning a real agent.
import type { AgentDeckApi, AgentOptions, AppSettings, HistoryEvent, SessionSummary } from '@shared/api'
import { defaultConfig, type AgentConfig, type AgentEvent, type Scope } from '@shared/events'
import { describeMode } from '@shared/format'

export function installDemoApi() {
  const listeners = new Set<(e: AgentEvent) => void>()
  const emit = (e: AgentEvent) => listeners.forEach((l) => l(e))
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  let settings: AppSettings = {
    defaultAgent: 'claude',
    claudePath: 'claude',
    piPath: 'pi',
    permissionMode: 'acceptEdits',
    piSubagentTools: ['subagent'],
    lastCwd: 'D:\\Projects\\agent-deck',
    agentConfig: { claude: defaultConfig(), pi: defaultConfig() }
  }

  async function stream(scope: Scope, id: string, text: string) {
    for (const word of text.split(/(?<= )/)) {
      emit({ kind: 'text-delta', scope, messageId: id, text: word })
      await wait(25)
    }
  }

  async function run(prompt: string) {
    emit({ kind: 'user-message', text: prompt })
    emit({ kind: 'turn-start' })
    await stream('main', 'm1', "I'll split this up: one subagent maps the adapters while another audits the reducer. ")
    emit({ kind: 'stats', stats: { contextUsed: 18400, inputTokens: 18400, outputTokens: 120, costUsd: 0.021 } })
    for (const [id, label, type] of [
      ['a1', 'Map adapter protocols', 'Explore'],
      ['a2', 'Audit session reducer', 'general-purpose']
    ]) {
      emit({ kind: 'tool-start', scope: 'main', toolId: id, name: 'Agent', input: { description: label, subagent_type: type } })
      emit({ kind: 'subagent-start', subagentId: id, label, agentType: type })
      // Staggered launches, so the timeline shows real overlap.
      await wait(800)
    }
    // A pi-subagents workflow: one card for the workflow, one per lane.
    emit({ kind: 'subagent-start', subagentId: 'wf', label: 'Workflow', agentType: 'workflow' })
    for (const [key, label] of [['arch', 'Architecture review'], ['build', 'Build health review']]) {
      emit({ kind: 'subagent-start', subagentId: `wf/${key}`, label, agentType: 'reviewer' })
      emit({ kind: 'subagent-update', subagentId: `wf/${key}`, model: 'thinkingmachines/inkling:free', activity: '▸ read' })
    }
    emit({ kind: 'subagent-update', subagentId: 'wf', activity: '2 of 2 lanes running' })
    setTimeout(() => {
      emit({ kind: 'subagent-update', subagentId: 'wf/build', activity: 'Ended: failed' })
      emit({ kind: 'subagent-end', subagentId: 'wf/build', status: 'error' })
      emit({ kind: 'subagent-update', subagentId: 'wf', activity: '1 of 2 lanes running' })
    }, 2500)
    // Like Claude: a requested alias first, then the full id once it replies.
    emit({ kind: 'subagent-update', subagentId: 'a1', model: 'haiku' })
    emit({ kind: 'subagent-update', subagentId: 'a2', model: 'claude-opus-5-5' })
    setTimeout(() => emit({ kind: 'subagent-update', subagentId: 'a1', model: 'claude-haiku-4-5-20251001' }), 900)
    const steps: [string, string, string][] = [
      ['a1', 'Grep', 'parent_tool_use_id'],
      ['a2', 'Read', 'src/shared/session.ts'],
      ['a1', 'Read', 'src/main/agents/claude.ts'],
      ['a2', 'Bash', 'npx vitest run'],
      ['a1', 'Read', 'src/main/agents/pi.ts']
    ]
    let n = 0
    for (const [sub, name, arg] of steps) {
      const toolId = `t${++n}`
      const input = name === 'Bash' ? { command: arg } : name === 'Grep' ? { pattern: arg } : { file_path: arg }
      emit({ kind: 'tool-start', scope: { subagentId: sub }, toolId, name, input })
      await wait(700)
      emit({ kind: 'tool-end', scope: { subagentId: sub }, toolId, output: `…output of ${name} ${arg}…`, isError: false })
      emit({ kind: 'stats', stats: { contextUsed: 18400 + n * 9000, inputTokens: 30000 + n * 12000, outputTokens: 400 + n * 150, costUsd: 0.021 + n * 0.018 } })
    }
    await stream({ subagentId: 'a2' }, 's2', 'The reducer handles **out-of-order** tool updates by matching ids. All 9 tests pass.')
    emit({ kind: 'tool-end', scope: 'main', toolId: 'a2', output: 'Reducer audit complete.', isError: false })
    emit({ kind: 'subagent-end', subagentId: 'a2', status: 'done' })
    await wait(1500)
    await stream({ subagentId: 'a1' }, 's1', 'Both adapters normalize into `AgentEvent`; Pi subagents come from the `subagent` extension tool.')
    emit({ kind: 'tool-end', scope: 'main', toolId: 'a1', output: 'Protocol map complete.', isError: false })
    emit({ kind: 'subagent-end', subagentId: 'a1', status: 'done' })
    await stream(
      'main',
      'm2',
      'Both subagents are done.\n\n- **Claude**: subagent messages carry `parent_tool_use_id`.\n- **Pi**: subagents are an extension tool, so they are matched by tool name.\n\n```ts\nexport function scopeKey(scope: Scope) {\n  return scope === \'main\' ? \'main\' : scope.subagentId\n}\n```'
    )
    emit({ kind: 'stats', stats: { contextUsed: 152000, contextMax: 200000, inputTokens: 98000, outputTokens: 1900, cacheRead: 61000, costUsd: 0.1374 } })
    emit({ kind: 'turn-end' })
  }

  /** Plan mode: read-only exploration, then a plan waiting for approval. */
  async function plan(prompt: string) {
    emit({ kind: 'user-message', text: prompt })
    emit({ kind: 'turn-start' })
    for (const [toolId, file] of [['p1', 'src/shared/session.ts'], ['p2', 'src/renderer/src/components/TopBar.svelte']]) {
      emit({ kind: 'tool-start', scope: 'main', toolId, name: 'Read', input: { file_path: file } })
      await wait(500)
      emit({ kind: 'tool-end', scope: 'main', toolId, output: `…contents of ${file}…`, isError: false })
    }
    await stream(
      'main',
      'plan1',
      "Here's the plan:\n\n1. Add a `mode` field to `AgentConfig`.\n2. Map it to each agent's own mechanism.\n3. Add a toggle to the top bar.\n\nNothing has been changed yet."
    )
    emit({ kind: 'turn-end' })
  }

  // Mirrors the real adapters: Claude has fixed choices; Pi reports its own.
  const claudeOptions: AgentOptions = {
    models: [
      { id: 'fable', label: 'Fable' },
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' }
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max']
  }
  const piOptions: AgentOptions = {
    models: [
      { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
      { id: 'openrouter/openrouter/free', label: 'Free Models Router' },
      // Pad to OpenRouter scale so the picker is exercised realistically.
      ...Array.from({ length: 400 }, (_, i) => ({ id: `openrouter/vendor-${i % 23}/model-${i}`, label: `Vendor ${i % 23}: Model ${i}` }))
    ],
    efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
  }
  let config: AgentConfig = defaultConfig()

  const hour = 3_600_000
  const saved = (agent: SessionSummary['agent'], id: string, title: string, ago: number): SessionSummary => ({
    agent,
    id,
    path: `demo/${id}.jsonl`,
    cwd: settings.lastCwd,
    title,
    startedAt: Date.now() - ago - hour,
    updatedAt: Date.now() - ago
  })
  const history = [
    saved('claude', 'demo-1', 'Review the adapter layer for protocol bugs', 2 * hour),
    saved('pi', 'demo-2', 'Add a context meter to the top bar', 30 * hour),
    saved('claude', 'demo-3', 'Why does the subagent panel flicker on resize?', 9 * 24 * hour)
  ]
  function savedEvents(s: SessionSummary): HistoryEvent[] {
    const t = s.startedAt
    const sub = { subagentId: 'saved-sub' }
    const events: AgentEvent[] = [
      { kind: 'user-message', text: s.title },
      { kind: 'text-delta', scope: 'main', messageId: 'saved-a1', text: "I'll send a reviewer to read through it." },
      { kind: 'tool-start', scope: 'main', toolId: 'saved-sub', name: 'Agent', input: { description: 'Read the adapters' } },
      { kind: 'subagent-start', subagentId: 'saved-sub', label: 'Read the adapters', agentType: 'Explore' },
      { kind: 'user-message', text: 'Read src/main/agents and report anything suspicious.', scope: sub },
      { kind: 'text-delta', scope: sub, messageId: 'saved-s1', text: 'Nothing alarming; two small edge cases noted.' },
      { kind: 'tool-end', scope: 'main', toolId: 'saved-sub', output: 'Two small edge cases.', isError: false },
      { kind: 'subagent-end', subagentId: 'saved-sub', status: 'done' },
      { kind: 'text-delta', scope: 'main', messageId: 'saved-a2', text: 'The reviewer found two small edge cases; details are in its card.' },
      { kind: 'turn-end' }
    ]
    return events.map((event, i) => ({ at: t + i * 20_000, event }))
  }

  const api: AgentDeckApi = {
    async start(opts) {
      config = { model: opts.model ?? '', effort: opts.effort ?? '', mode: opts.mode ?? 'auto' }
      const resolved = config.model || (opts.agent === 'pi' ? 'anthropic/claude-sonnet-5-5' : 'opus')
      emit({ kind: 'session', agent: opts.agent, sessionId: 'demo', model: resolved })
      emit({ kind: 'options', ...(opts.agent === 'pi' ? piOptions : claudeOptions) })
      emit({ kind: 'config', config })
      emit({ kind: 'stats', stats: { contextMax: 200000 } })
    },
    async send(text) {
      void (config.mode === 'plan' ? plan(text) : run(text))
    },
    async abort() {},
    async configure(change) {
      config = { ...config, ...change }
      emit({ kind: 'config', config })
      if (change.mode && !change.model && !change.effort) return emit({ kind: 'notice', text: describeMode(change.mode) })
      if (change.model) emit({ kind: 'session', agent: settings.defaultAgent, sessionId: 'demo', model: change.model })
      emit({
        kind: 'notice',
        text: `Now using ${config.model || 'the default model'} with ${config.effort ? `${config.effort === 'xhigh' ? 'extra high' : config.effort} effort` : 'default effort'}.`
      })
    },
    async getOptions(agent) {
      return agent === 'claude' ? claudeOptions : { models: [], efforts: [] }
    },
    async stop() {
      emit({ kind: 'exit', code: 0 })
    },
    async pickDirectory() {
      return settings.lastCwd
    },
    async getSettings() {
      return settings
    },
    async saveSettings(patch) {
      return (settings = { ...settings, ...patch })
    },
    async listSessions(cwd) {
      return cwd ? history : []
    },
    async loadSession(s) {
      return savedEvents(s)
    },
    onEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
  window.agentDeck = api
}
