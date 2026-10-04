<script lang="ts">
  import { onMount } from 'svelte'
  import type { AgentConfig, AgentId, ModelOption } from '@shared/events'
  import type { AppSettings } from '@shared/api'
  import { contextLevel, formatTokens, shortModel } from '@shared/format'
  import { resetSession, session } from '../lib/session.svelte'
  import ModelPicker from './ModelPicker.svelte'
  import SessionHistory from './SessionHistory.svelte'
  import Select from './Select.svelte'

  /** Before the first message the bar is the setup screen, centred in the main pane. */
  let { setup = false }: { setup?: boolean } = $props()

  let agent = $state<AgentId>('claude')
  let cwd = $state('')
  let starting = $state(false)
  let settings = $state<AppSettings | null>(null)

  // Before a session: the adapter's static choices and the saved selection.
  let staticModels = $state<ModelOption[]>([])
  let staticEfforts = $state<string[]>([])
  let draft = $state<AgentConfig>({ model: '', effort: '' })

  onMount(async () => {
    settings = await window.agentDeck.getSettings()
    agent = settings.defaultAgent
    cwd = settings.lastCwd
  })

  // Reload choices whenever the selected agent changes.
  $effect(() => {
    const a = agent
    window.agentDeck.getOptions(a).then((o) => {
      staticModels = o.models
      staticEfforts = o.efforts
    })
    draft = { ...(settings?.agentConfig[a] ?? { model: '', effort: '' }) }
  })

  // While running, the agent's live choices and config win.
  const models = $derived(session.running && session.models.length ? session.models : staticModels)
  const efforts = $derived(session.running && session.efforts.length ? session.efforts : staticEfforts)
  const current = $derived(session.running ? session.config : draft)

  // Once the agent reports what "default" resolved to, say so.
  const defaultLabel = $derived(session.running && session.model ? `Default (${shortModel(session.model)})` : 'Default')
  const modelOptions = $derived(withCurrent(
    [{ value: '', label: defaultLabel }, ...models.map((m) => ({ value: m.id, label: m.label }))],
    current.model
  ))
  const effortOptions = $derived(withCurrent(
    [{ value: '', label: 'Default' }, ...efforts.map((e) => ({ value: e, label: effortLabel(e) }))],
    current.effort
  ))

  /** Keep a saved value selectable even if the agent doesn't list it. */
  function withCurrent(opts: { value: string; label: string }[], value: string) {
    return value && !opts.some((o) => o.value === value) ? [...opts, { value, label: value }] : opts
  }

  function effortLabel(e: string) {
    return e === 'xhigh' ? 'Extra high' : e.charAt(0).toUpperCase() + e.slice(1)
  }

  function change(field: keyof AgentConfig, value: string) {
    if (session.running) window.agentDeck.configure({ [field]: value })
    else draft[field] = value
  }

  const stats = $derived(session.stats)
  const ctxPct = $derived(stats.contextMax ? Math.min(100, (stats.contextUsed / stats.contextMax) * 100) : 0)

  const folderName = $derived(cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : '')

  async function pick() {
    const dir = await window.agentDeck.pickDirectory()
    if (dir) cwd = dir
  }

  // A saved session fixes the agent and folder; continuing it reuses both.
  const replay = $derived(session.replay)
  const locked = $derived(session.running || !!replay)
  $effect(() => {
    if (!replay) return
    agent = replay.agent
    cwd = replay.cwd
  })

  async function start() {
    if (!cwd) await pick()
    if (!cwd) return
    starting = true
    // Continuing keeps the saved transcript; new turns append below it.
    // Claude may report a new id after a resume, so prefer the live one.
    const resume = replay ? { id: session.sessionId || replay.id, path: replay.path } : undefined
    if (!resume) resetSession()
    try {
      await window.agentDeck.start({ agent, cwd, ...draft, resume })
      if (settings) settings.agentConfig[agent] = { ...draft }
    } finally {
      starting = false
    }
  }

  async function stop() {
    // Carry the session's final choices into the next start.
    draft = { ...session.config }
    if (settings) settings.agentConfig[agent] = { ...draft }
    await window.agentDeck.stop()
  }

  $effect(() => {
    if (session.running) starting = false
  })
</script>

<header class="bar" class:setup>
  {#if setup}
    <div class="intro">
      <h1>New session</h1>
      <p>Choose an agent and a project folder. Subagents appear on the right as they launch.</p>
    </div>
  {/if}

  <div class="field">
    <span class="flabel" id="agent-label">Agent</span>
    <div class="agents" role="radiogroup" aria-labelledby="agent-label">
      {#each [['claude', 'Claude Code'], ['pi', 'Pi']] as [id, name] (id)}
        <button
          role="radio"
          aria-checked={agent === id}
          class:on={agent === id}
          disabled={locked}
          onclick={() => (agent = id as AgentId)}>{name}</button
        >
      {/each}
    </div>
  </div>

  <div class="field folder-field">
    <span class="flabel">Project folder</span>
    <button class="folder" onclick={pick} disabled={locked} title={cwd || 'Choose a project folder'}>
      {(setup ? cwd : folderName) || 'Choose project folder'}
    </button>
  </div>

  <div class="field pair">
    <ModelPicker
      value={current.model}
      options={modelOptions}
      title={!session.running && agent === 'pi' && !models.length ? 'Pi lists its models once the session starts' : ''}
      onchange={(v) => change('model', v)}
    />
    <Select label="Effort" value={current.effort} options={effortOptions} onchange={(v) => change('effort', v)} />
  </div>

  {#if !setup}
    <div class="status">
      {#if session.running}
        <span class="dot" class:busy={session.busy} title={session.busy ? 'Working' : 'Idle'}></span>
        <span class="sr-only">{session.busy ? 'Working' : 'Idle'}</span>
        {#if stats.contextMax}
          <span
            class="ctx"
            data-level={contextLevel(ctxPct)}
            title="{formatTokens(stats.contextUsed)} of {formatTokens(stats.contextMax)} tokens"
          >
            <span class="ctx-label">Context</span>
            <span
              class="ctx-meter"
              role="meter"
              aria-label="Context window used"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={Math.round(ctxPct)}
            >
              <span class="ctx-fill" style:width="{ctxPct}%"></span>
            </span>
            <span class="ctx-pct">{Math.round(ctxPct)}%</span>
          </span>
        {/if}
      {/if}
    </div>
  {/if}

  {#if session.running}
    <button class="action" onclick={stop}>End session</button>
  {:else}
    <button class="action primary" onclick={start} disabled={starting}>
      {starting ? 'Starting…' : replay ? 'Continue session' : 'Start session'}
    </button>
  {/if}

  {#if setup}
    <SessionHistory {cwd} />
  {/if}
</header>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 28px;
    border-bottom: 1px solid var(--line);
    min-height: 54px;
  }
  /* Only the compact bar responds to its width; the setup form is always narrow. */
  .bar:not(.setup) {
    container-type: inline-size;
  }
  .field {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .flabel,
  .intro {
    display: none;
  }

  /* Setup: the same controls as a centred, labelled form. */
  .bar.setup {
    flex: 1;
    flex-direction: column;
    align-items: stretch;
    justify-content: center;
    gap: 18px;
    width: min(460px, 100%);
    margin: 0 auto;
    padding: 0 28px 10vh;
    border-bottom: none;
  }
  .setup .intro {
    display: block;
    margin-bottom: 6px;
  }
  .intro h1 {
    margin: 0 0 6px;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .intro p {
    margin: 0;
    color: var(--muted);
  }
  .setup .field {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .setup .flabel {
    display: block;
    font-size: 13px;
    color: var(--muted);
  }
  .setup .pair {
    flex-direction: row;
    gap: 10px;
  }
  .setup .pair > :global(*) {
    flex: 1;
    min-width: 0;
  }
  .setup .pair :global(.trigger) {
    width: 100%;
    max-width: none;
    padding-block: 7px;
  }
  .setup .pair :global(.select) {
    padding-block: 7px;
  }
  .setup .pair :global(select) {
    flex: 1;
    max-width: none;
  }
  .setup .agents button {
    flex: 1;
    padding: 6px 14px;
  }
  .setup .folder {
    max-width: none;
    padding: 8px 12px;
    text-align: left;
    font-family: var(--mono);
    font-size: 13px;
  }
  .setup .action {
    margin-top: 6px;
    padding: 10px 16px;
    font-size: 15px;
  }

  .agents {
    display: flex;
    padding: 3px;
    border-radius: var(--radius);
    background: var(--sunken);
    border: 1px solid var(--line);
  }
  .agents button {
    border: none;
    background: none;
    padding: 4px 14px;
    border-radius: 5px;
    color: var(--muted);
    font-size: 14px;
    white-space: nowrap;
  }
  .agents button.on {
    background: var(--raised);
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .agents button:disabled:not(.on) {
    opacity: 0.4;
    cursor: default;
  }

  /* Only the folder name gives way when the bar gets tight. */
  .folder-field {
    flex-shrink: 1;
    min-width: 48px;
  }
  .folder {
    background: none;
    border: 1px dashed var(--line);
    border-radius: var(--radius);
    padding: 5px 12px;
    font-size: 14px;
    max-width: min(280px, 100%);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .folder:hover:not(:disabled) {
    border-color: var(--muted);
  }
  .folder:disabled {
    border-style: solid;
    cursor: default;
  }

  .status {
    flex: 1 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--muted);
    font-size: 13px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--done);
    flex-shrink: 0;
  }
  .dot.busy {
    background: var(--running);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }

  /* Context fill decides when to act, so it lives up here, always in view. */
  .ctx {
    display: flex;
    align-items: center;
    gap: 7px;
    font-variant-numeric: tabular-nums;
  }
  .ctx-meter {
    width: 72px;
    height: 6px;
    border-radius: 3px;
    background: var(--line);
    overflow: hidden;
  }
  .ctx-fill {
    display: block;
    height: 100%;
    background: var(--done);
    transition:
      width 0.4s ease,
      background-color 0.4s;
  }
  .ctx-pct {
    color: var(--text);
    min-width: 3ch;
  }
  [data-level='mid'] .ctx-fill {
    background: var(--warn);
  }
  [data-level='high'] .ctx-fill {
    background: var(--error);
  }
  [data-level='high'] .ctx-pct {
    color: var(--error);
    font-weight: 600;
  }

  .action {
    flex-shrink: 0;
    border: 1px solid var(--line);
    background: var(--raised);
    border-radius: var(--radius);
    padding: 6px 16px;
    font-size: 14px;
    white-space: nowrap;
  }
  .action.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--ink);
    font-weight: 600;
  }
  .action:disabled {
    opacity: 0.6;
    cursor: default;
  }

  /* Narrow windows: tighten up and drop inline labels before anything gets clipped. */
  @media (max-width: 1100px) {
    .bar:not(.setup) {
      padding-inline: 16px;
      gap: 10px;
    }
  }
  @container (max-width: 860px) {
    .field,
    .status {
      gap: 8px;
    }
    .ctx-meter {
      width: 52px;
    }
    .ctx-label,
    .field :global(.label) {
      display: none;
    }
  }
</style>
