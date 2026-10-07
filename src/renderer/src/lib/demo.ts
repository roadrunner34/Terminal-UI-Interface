// Browser-only stand-in for the Electron preload API. Loaded when the
// renderer runs outside Electron (e.g. `vite` preview) so the UI can be
// developed and reviewed without spawning a real agent.
import type {
  AgentDeckApi,
  AgentOptions,
  AppSettings,
  HistoryEvent,
  PiContextFile,
  PiOutput,
  PiPackage,
  SessionSummary
} from '@shared/api'
import {
  defaultConfig,
  type AgentConfig,
  type AgentEvent,
  type ImageAttachment,
  type McpAction,
  type McpServer,
  type PromptAnswer,
  type Scope,
  type UserPrompt
} from '@shared/events'
import { describeMode, PLAN_APPROVAL, summarizeSessionOptions } from '@shared/format'

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
    agentConfig: { claude: defaultConfig(), pi: defaultConfig() },
    sessionOptions: { claude: {}, pi: {} }
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

    /** MCP servers as Claude's mcp_status reports them; actions change them after a pause. */
    let servers: McpServer[] = [
      {
        name: 'plugin:playwright:playwright',
        status: 'connected',
        version: '1.64.0',
        scope: 'dynamic',
        source: 'plugin',
        transport: 'stdio',
        tools: [{ name: 'browser_snapshot', readOnly: true }, { name: 'browser_click' }, { name: 'browser_navigate' }]
      },
      { name: 'plugin:context7:context7', status: 'needs-auth', scope: 'dynamic', source: 'plugin', transport: 'http' },
      { name: 'github', status: 'connected', version: '0.9.2', scope: 'user', transport: 'http', tools: [{ name: 'search_issues', readOnly: true }, { name: 'create_pull_request' }] },
      { name: 'local-db', status: 'failed', error: 'Connection failed', scope: 'project', transport: 'stdio' },
      { name: 'broken-server', status: 'invalid', error: 'url entry has no type' }
    ]
    async function mcp(action: McpAction, name = '') {
      if (action === 'status') return emit({ kind: 'mcp', servers: structuredClone(servers) })
      emit({ kind: 'mcp-busy', name, busy: true })
      await wait(900)
      emit({ kind: 'mcp-busy', name, busy: false })
      const s = servers.find((m) => m.name === name)
      if (!s) return emit({ kind: 'notice', text: `${name}: Server not found: ${name}` })
      const status: Partial<Record<McpAction, string>> = { reconnect: 'connected', enable: 'connected', disable: 'disabled', auth: 'connected', logout: 'needs-auth' }
      s.status = status[action] ?? s.status
      delete s.error
      if (s.status === 'connected') s.tools ??= [{ name: 'resolve-library-id', readOnly: true }, { name: 'query-docs', readOnly: true }]
      const said: Partial<Record<McpAction, string>> = {
        reconnect: `Reconnected ${name}.`,
        enable: `Enabled ${name}. This is saved to your Claude settings.`,
        disable: `Disabled ${name}. This is saved to your Claude settings.`,
        auth: `Signed in to ${name}.`,
        logout: `Signed out of ${name}.`
      }
      emit({ kind: 'notice', text: said[action] ?? '' })
      emit({ kind: 'mcp', servers: structuredClone(servers) })
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
      mcp,
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

  /** Pi packages, as the package browser lists them. */
  let packages: PiPackage[] = [
    { source: 'npm:pi-subagents', scope: 'user', kind: 'npm', filtered: false, installed: true, name: 'pi-subagents', version: '0.76.1', description: 'Pi extension for single-agent delegation and scripted multi-agent work.', resources: { extensions: 1, skills: 2 } },
    { source: 'npm:pi-plan', scope: 'user', kind: 'npm', filtered: false, installed: true, name: 'pi-plan', version: '0.1.1', description: 'Plan mode for pi — read-only exploration with plan-then-execute workflow', resources: { extensions: 1 } },
    { source: 'git:github.com/acme/pi-team-skills', scope: 'project', kind: 'git', filtered: true, installed: false }
  ]
  let packageBusy = false
  const piListeners = new Set<(o: PiOutput) => void>()

  /** Pi's instruction files, by kind; absent until written. */
  const contextFiles = new Map<PiContextFile, string>([
    ['project-agents', '# Agent Deck\n\n- Run `npm test` before finishing.\n- Keep components small.\n'],
    ['global-system', 'You are a careful coding agent. (A SYSTEM.md replaces Pi\'s whole prompt.)\n']
  ])
  const demoContextPath = (cwd: string, which: PiContextFile) =>
    ({
      'project-agents': `${cwd}\\AGENTS.md`,
      'project-append': `${cwd}\\.pi\\APPEND_SYSTEM.md`,
      'global-agents': 'C:\\Users\\you\\.pi\\agent\\AGENTS.md',
      'project-system': `${cwd}\\.pi\\SYSTEM.md`,
      'global-system': 'C:\\Users\\you\\.pi\\agent\\SYSTEM.md'
    })[which]

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
      const advanced = summarizeSessionOptions(opts.advanced)
      if (advanced) emit({ kind: 'notice', text: `Demo: started with ${advanced}.` })
      if (opts.agent === 'claude') void a.mcp('status')
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
    async mcp(tab, action, name) {
      await agentFor(tab).mcp(action, name)
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
    async pickFile() {
      return 'D:\\Projects\\agent-deck\\.mcp.json'
    },
    async readContext(cwd, which) {
      const path = demoContextPath(cwd, which)
      const text = contextFiles.get(which)
      return { which, path, exists: text !== undefined, text: text ?? '', readOnly: which.endsWith('system') }
    },
    async writeContext(cwd, which, text) {
      contextFiles.set(which, text)
      return { which, path: demoContextPath(cwd, which), exists: true, text, readOnly: false }
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
    async listPiPackages(cwd) {
      return packages.filter((p) => p.scope === 'user' || cwd)
    },
    async runPiPackage(op) {
      if (packageBusy) return { error: 'Another package command is still running.' }
      const source = op.source?.trim() ?? ''
      if (op.op !== 'update-all' && !/^(npm:|git:|https:\/\/)\S+$/.test(source))
        return { error: 'Use an npm or git source, such as npm:pi-foo or git:github.com/user/repo.' }
      const id = `demo-pkg-${Date.now()}`
      const out = (o: PiOutput) => piListeners.forEach((l) => l(o))
      packageBusy = true
      void (async () => {
        const verb = { install: 'Installing', remove: 'Removing', update: 'Updating', 'update-all': 'Updating' }[op.op]
        const lines = [`$ pi ${op.op === 'update-all' ? 'update --extensions' : `${op.op} ${source}${op.local ? ' -l' : ''}`}`, `${verb} ${source || 'all packages'}...`, '', 'added 1 package, and audited 2 packages in 1s', '', 'found 0 vulnerabilities']
        for (const line of lines) {
          await wait(250)
          out({ id, line })
        }
        const fail = source.includes('missing')
        if (fail) out({ id, line: `npm error 404 Not Found - GET https://registry.npmjs.org/${source.slice(4)}` })
        else {
          out({ id, line: `${{ install: 'Installed', remove: 'Removed', update: 'Updated', 'update-all': 'Updated' }[op.op]} ${source || 'all packages'}` })
          const name = source.replace(/^npm:/, '')
          if (op.op === 'install' && !packages.some((p) => p.source === source))
            packages.push({ source, scope: op.local ? 'project' : 'user', kind: 'npm', filtered: false, installed: true, name, version: '0.1.0', description: 'Installed from the demo.', resources: { extensions: 1 } })
          if (op.op === 'remove') packages = packages.filter((p) => !(p.source === source && p.scope === (op.local ? 'project' : 'user')))
        }
        packageBusy = false
        out({ id, exit: fail ? 1 : 0 })
      })()
      return { id }
    },
    onPiOutput(cb) {
      piListeners.add(cb)
      return () => piListeners.delete(cb)
    },
    async searchPiPackages(query) {
      await wait(300)
      const all = [
        { name: 'pi-web-access', version: '0.37.0', description: 'Web search, URL fetching, GitHub repo cloning and PDF extraction.', weeklyDownloads: 230465 },
        { name: 'pi-mcp-adapter', version: '5.1.0', description: 'MCP adapter extension for Pi.', weeklyDownloads: 534097 },
        { name: 'pi-subagents', version: '0.76.1', description: 'Single-agent delegation and scripted multi-agent work.', weeklyDownloads: 189867 },
        { name: 'pi-goal-x', version: '0.32.3', description: 'Adds /goal: conversational goal planning.', weeklyDownloads: 38556 },
        { name: '<img src=x onerror=alert(1)>', version: '0.0.1', description: 'Rendered as text, never HTML.', weeklyDownloads: 3 }
      ]
      const q = query.trim().toLowerCase()
      return all.filter((p) => !q || p.name.includes(q) || p.description.toLowerCase().includes(q))
    },
    async reloadPiTabs() {
      return { reloaded: 1, later: 0 }
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
