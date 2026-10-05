// Browser-only stand-in for the Electron preload API. Loaded when the
// renderer runs outside Electron (e.g. `vite` preview) so the UI can be
// developed and reviewed without spawning a real agent.
import type { AgentDeckApi, AgentOptions, AppSettings, HistoryEvent, SessionSummary } from '@shared/api'
import {
  defaultConfig,
  type AgentConfig,
  type AgentEvent,
  type ImageAttachment,
  type PromptAnswer,
  type Scope,
  type UserPrompt
} from '@shared/events'
import { describeMode, PLAN_APPROVAL } from '@shared/format'

export function installDemoApi() {
  const listeners = new Set<(tab: string, e: AgentEvent) => void>()
  const emitTo = (tab: string, e: AgentEvent) => listeners.forEach((l) => l(tab, e))
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  let settings: AppSettings = {
    defaultAgent: 'claude',
    claudePath: 'claude',
    piPath: 'pi',
    permissionMode: 'acceptEdits',
    approvals: 'ask',
    notifications: true,
    piSubagentTools: ['subagent'],
    piAutoCompaction: true,
    lastCwd: 'D:\\Projects\\agent-deck',
    agentConfig: { claude: defaultConfig(), pi: defaultConfig() }
  }

  /** Prompts waiting on the user, resolved by answerPrompt. */
  const prompts = new Map<string, (a: PromptAnswer) => void>()
  let promptSeq = 0

  /** One scripted agent per tab, so tabs can run side by side. */
  function demoAgent(tab: string) {
    const emit = (e: AgentEvent) => emitTo(tab, e)
    let config: AgentConfig = defaultConfig()
    let busy = false
    /** Follow-ups sent mid-turn, delivered when the turn ends. */
    let queued: string[] = []
    /** Prompts by entry id, so a fork can hand one back. */
    const sent = new Map<string, string>()
    let entrySeq = 0
    let bgTimer: ReturnType<typeof setTimeout> | undefined
    function ask(scope: Scope, prompt: UserPrompt): Promise<PromptAnswer> {
      const id = `demo-prompt-${++promptSeq}`
      emit({ kind: 'prompt-request', id, scope, prompt })
      return new Promise((resolve) => prompts.set(id, resolve))
    }

    async function stream(scope: Scope, id: string, text: string) {
      for (const word of text.split(/(?<= )/)) {
        emit({ kind: 'text-delta', scope, messageId: id, text: word })
        await wait(25)
      }
    }

    async function run(prompt: string) {
      busy = true
      emit({ kind: 'turn-start' })
      // A slow hook shows as a row; quick ones stay hidden.
      emit({ kind: 'tool-start', scope: 'main', toolId: 'hook-1', name: 'Hook', input: { description: 'UserPromptSubmit' } })
      // A backgrounded dev server: its card can be stopped.
      emit({ kind: 'subagent-start', subagentId: 'task:dev', label: 'Start the dev server', agentType: 'background shell', taskId: 'dev' })
      emit({ kind: 'subagent-update', subagentId: 'task:dev', activity: 'Running in the background' })
      bgTimer = setTimeout(() => {
        emit({ kind: 'text', scope: { subagentId: 'task:dev' }, messageId: 'dev-summary', text: 'Background command "Start the dev server" completed (exit code 0)' })
        emit({ kind: 'subagent-end', subagentId: 'task:dev', status: 'done' })
      }, 40_000)
      await wait(1600)
      emit({ kind: 'tool-end', scope: 'main', toolId: 'hook-1', output: 'Checked the prompt against the team policy.', isError: false })
      // A provider hiccup first, like Claude's api_retry: the first text clears it.
      emit({ kind: 'retry', attempt: 1, max: 10, delayMs: 3000, reason: 'API overloaded (529)' })
      await wait(3000)
      // Claude's task checklist: TaskCreate replies with the new task's id.
      const tasks = [
        ['Map the adapter protocols', 'Mapping the adapter protocols'],
        ['Audit the session reducer', 'Auditing the session reducer'],
        ['Fix what turns up', 'Fixing what turned up']
      ]
      for (const [i, [subject, activeForm]] of tasks.entries()) {
        const toolId = `task-${i + 1}`
        emit({ kind: 'tool-start', scope: 'main', toolId, name: 'TaskCreate', input: { subject, activeForm } })
        emit({ kind: 'tool-end', scope: 'main', toolId, output: `Task #${i + 1} created successfully: ${subject}`, isError: false })
      }
      const setTask = (taskId: string, status: string) => {
        const toolId = `task-up-${taskId}-${status}`
        emit({ kind: 'tool-start', scope: 'main', toolId, name: 'TaskUpdate', input: { taskId, status } })
        emit({ kind: 'tool-end', scope: 'main', toolId, output: `Updated task #${taskId} status`, isError: false })
      }
      setTask('1', 'in_progress')
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
        // Like Claude without a matching allow rule: Bash waits for approval.
        if (name === 'Bash') {
          const a = await ask({ subagentId: sub }, { type: 'tool-approval', tool: name, input, description: 'Run the test suite', canAlways: true })
          if (!('allow' in a && a.allow)) {
            emit({ kind: 'tool-end', scope: { subagentId: sub }, toolId, output: 'The user denied this tool call.', isError: true })
            continue
          }
        }
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
      setTask('1', 'completed')
      setTask('2', 'completed')
      setTask('3', 'in_progress')
      const edit = {
        file_path: 'D:\\Projects\\agent-deck\\src\\shared\\session.ts',
        old_string: "    case 'turn-end':\n      s.busy = false\n      break",
        new_string: "    case 'turn-end':\n      // Background runs keep going; adapters end them explicitly.\n      s.busy = false\n      s.turns++\n      break"
      }
      emit({ kind: 'tool-start', scope: 'main', toolId: 'e1', name: 'Edit', input: edit })
      await wait(400)
      emit({ kind: 'tool-end', scope: 'main', toolId: 'e1', output: 'The file has been updated successfully.', isError: false })
      emit({ kind: 'tool-start', scope: 'main', toolId: 'b1', name: 'Bash', input: { command: 'npx vitest run test/adapters.test.ts', description: 'Run the adapter tests' } })
      await wait(600)
      emit({ kind: 'tool-end', scope: 'main', toolId: 'b1', output: ' ✓ test/adapters.test.ts (24 tests) 38ms\n\n Test Files  1 passed (1)\n      Tests  24 passed (24)', isError: false })
      setTask('3', 'completed')
      await stream(
        'main',
        'm2',
        'Both subagents are done.\n\n- **Claude**: subagent messages carry `parent_tool_use_id`.\n- **Pi**: subagents are an extension tool, so they are matched by tool name.\n\n```ts\nexport function scopeKey(scope: Scope) {\n  return scope === \'main\' ? \'main\' : scope.subagentId\n}\n```'
      )
      emit({ kind: 'stats', stats: { contextUsed: 152000, contextMax: 200000, inputTokens: 98000, outputTokens: 1900, cacheRead: 61000, costUsd: 0.1374 } })
      await finish()
    }

    /** Ends a turn, or carries on with the next queued follow-up. */
    async function finish() {
      const next = queued.shift()
      if (next === undefined) {
        busy = false
        emit({ kind: 'turn-end' })
        return
      }
      emit({ kind: 'queue', messages: [...queued] })
      emit({ kind: 'user-message', text: next })
      await stream('main', `f${Date.now()}`, 'Done: that follow-up is handled too.')
      await finish()
    }

    function followUp(text: string) {
      queued.push(text)
      emit({ kind: 'queue', messages: [...queued] })
    }

    function clearQueue() {
      const n = queued.length
      queued = []
      emit({ kind: 'queue', messages: [] })
      if (n) emit({ kind: 'notice', text: `Removed ${n} queued message${n === 1 ? '' : 's'}.` })
    }

    function nextEntry(text: string) {
      const id = `demo-entry-${++entrySeq}`
      sent.set(id, text)
      return id
    }

    function fork(entryId: string) {
      const text = sent.get(entryId)
      if (text === undefined) return
      emit({ kind: 'truncate', entryId })
      emit({ kind: 'draft', text })
      emit({ kind: 'notice', text: 'Forked from before that message. Edit it and send to continue on the new branch.' })
    }

    async function rewind() {
      const a = await ask('main', {
        type: 'confirm',
        title: 'Restore 2 files to before this message?',
        message: 'session.ts, TopBar.svelte (+14 −3). The conversation stays as it is.'
      })
      if ('confirmed' in a && a.confirmed) emit({ kind: 'notice', text: 'Restored files to how they were before that message.' })
    }

    function stopTask(taskId: string) {
      clearTimeout(bgTimer)
      emit({ kind: 'subagent-update', subagentId: `task:${taskId}`, activity: 'Stopped' })
      emit({ kind: 'subagent-end', subagentId: `task:${taskId}`, status: 'done' })
    }

    async function shell(command: string) {
      const toolId = `shell-${Date.now()}`
      emit({ kind: 'turn-start' })
      emit({ kind: 'tool-start', scope: 'main', toolId, name: 'bash', input: { command, description: 'You ran this' } })
      await wait(500)
      emit({ kind: 'tool-end', scope: 'main', toolId, output: 'README.md  package.json  src  test', isError: false })
      emit({ kind: 'turn-end' })
    }

    async function compact() {
      emit({ kind: 'notice', text: 'Compacting the conversation…' })
      emit({ kind: 'turn-start' })
      await wait(1200)
      emit({ kind: 'compacted', auto: false, tokensBefore: 152000, tokensAfter: 31000 })
      emit({ kind: 'turn-end' })
    }

    /** Plan mode: read-only exploration, then a plan waiting for approval. */
    async function plan(prompt: string) {
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

    return {
      run,
      plan,
      emit,
      followUp,
      clearQueue,
      compact,
      nextEntry,
      fork,
      rewind,
      stopTask,
      shell,
      get busy() {
        return busy
      },
      get config() {
        return config
      },
      set config(c: AgentConfig) {
        config = c
      }
    }
  }
  const agents = new Map<string, ReturnType<typeof demoAgent>>()
  const agentFor = (tab: string) => agents.get(tab) ?? agents.set(tab, demoAgent(tab)).get(tab)!

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
    async start(tab, opts) {
      const a = agentFor(tab)
      const emit = a.emit
      const config = (a.config = { model: opts.model ?? '', effort: opts.effort ?? '', mode: opts.mode ?? 'auto' })
      const resolved = config.model || (opts.agent === 'pi' ? 'anthropic/claude-sonnet-5-5' : 'opus')
      emit({ kind: 'session', agent: opts.agent, sessionId: 'demo', model: resolved })
      emit({ kind: 'options', ...(opts.agent === 'pi' ? piOptions : claudeOptions) })
      emit({ kind: 'config', config })
      emit({ kind: 'stats', stats: { contextMax: 200000 } })
      if (opts.agent === 'claude')
        emit({
          kind: 'mcp',
          servers: [
            { name: 'playwright', status: 'connected' },
            { name: 'context7', status: 'needs-auth' },
            { name: 'github', status: 'connected' },
            { name: 'broken-server', status: 'invalid', error: 'url entry has no type' }
          ]
        })
      emit({
        kind: 'commands',
        commands: [
          { name: 'compact', description: 'Clear conversation history but keep a summary in context.' },
          { name: 'context', description: 'Show current context usage.' },
          { name: 'review', description: 'Review a pull request.' },
          { name: 'code-review:code-review', description: 'Code review a pull request.' },
          { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation.' }
        ]
      })
    },
    async send(tab, text, images?: ImageAttachment[], opts?) {
      const a = agentFor(tab)
      if (opts?.followUp && a.busy) return a.followUp(text)
      a.emit({ kind: 'user-message', text, entryId: a.nextEntry(text), ...(images?.length && { images }) })
      void (a.config.mode === 'plan' ? a.plan(text) : a.run(text))
    },
    async abort() {},
    async compact(tab) {
      await agentFor(tab).compact()
    },
    async clearQueue(tab) {
      agentFor(tab).clearQueue()
    },
    async contextUsage(tab) {
      agentFor(tab).emit({
        kind: 'context-usage',
        usage: {
          total: 26886,
          max: 200000,
          categories: [
            { name: 'System prompt', tokens: 6571, kind: 'used' },
            { name: 'System tools', tokens: 12275, kind: 'used' },
            { name: 'MCP server instructions', tokens: 2333, kind: 'used' },
            { name: 'MCP tools (deferred)', tokens: 50904, kind: 'deferred' },
            { name: 'Custom agents', tokens: 1932, kind: 'used' },
            { name: 'Skills', tokens: 1984, kind: 'used' },
            { name: 'Messages', tokens: 1791, kind: 'used' },
            { name: 'Free space', tokens: 173114, kind: 'free' }
          ]
        }
      })
    },
    async stopTask(tab, taskId) {
      agentFor(tab).stopTask(taskId)
    },
    async shell(tab, command) {
      await agentFor(tab).shell(command)
    },
    async rename(tab, title) {
      agentFor(tab).emit({ kind: 'title', title })
    },
    async exportSession(tab) {
      agentFor(tab).emit({ kind: 'notice', text: 'Exported the session to D:\\Projects\\agent-deck\\agent-deck-demo.html.' })
      return true
    },
    async fork(tab, entryId) {
      agentFor(tab).fork(entryId)
    },
    async rewind(tab) {
      await agentFor(tab).rewind()
    },
    async configure(tab, change) {
      const a = agentFor(tab)
      const emit = a.emit
      const config = (a.config = { ...a.config, ...change })
      emit({ kind: 'config', config })
      if (change.mode && !change.model && !change.effort) return emit({ kind: 'notice', text: describeMode(change.mode) })
      if (change.model) emit({ kind: 'session', agent: settings.defaultAgent, sessionId: 'demo', model: change.model })
      emit({
        kind: 'notice',
        text: `Now using ${config.model || 'the default model'} with ${config.effort ? `${config.effort === 'xhigh' ? 'extra high' : config.effort} effort` : 'default effort'}.`
      })
    },
    async answerPrompt(tab, id, answer) {
      prompts.get(id)?.(answer)
      prompts.delete(id)
      emitTo(tab, { kind: 'prompt-resolved', id })
    },
    async approvePlan(tab) {
      await api.configure(tab, { mode: 'auto' })
      await api.send(tab, PLAN_APPROVAL)
    },
    async getOptions(agent) {
      return agent === 'claude' ? claudeOptions : { models: [], efforts: [] }
    },
    async stop(tab) {
      emitTo(tab, { kind: 'exit', code: 0 })
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
    async listFiles() {
      return [
        'README.md',
        'package.json',
        'src/main/index.ts',
        'src/main/agents/claude.ts',
        'src/main/agents/pi.ts',
        'src/main/agents/process.ts',
        'src/shared/events.ts',
        'src/shared/session.ts',
        'src/shared/tools.ts',
        'src/renderer/src/App.svelte',
        'src/renderer/src/components/Composer.svelte',
        'src/renderer/src/lib/session.svelte.ts',
        'test/adapters.test.ts'
      ]
    },
    onEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    onFocusTab() {
      return () => {}
    }
  }
  window.agentDeck = api
}
