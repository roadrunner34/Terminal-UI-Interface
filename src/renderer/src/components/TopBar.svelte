<script lang="ts">
  import { onMount } from 'svelte'
  import { defaultConfig, type AgentConfig, type AgentId, type AgentMode, type ModelOption } from '@shared/events'
  import type { AppSettings } from '@shared/api'
  import { contextLevel, countSessionOptions, formatTokens, shortModel } from '@shared/format'
  import { activeTab, agent as api, resetSession, seedForms, session } from '../lib/session.svelte'
  import AdvancedOptions from './AdvancedOptions.svelte'
  import ModelPicker from './ModelPicker.svelte'
  import SessionHistory from './SessionHistory.svelte'
  import Select from './Select.svelte'
  import SettingsDialog from './SettingsDialog.svelte'

  /** Before the first message the bar is the setup screen, centred in the main pane. */
  let { setup = false }: { setup?: boolean } = $props()

  let settings = $state<AppSettings | null>(null)
  let settingsDialog: SettingsDialog

  // Before a session: the adapter's static choices and the saved selection.
  let staticModels = $state<ModelOption[]>([])
  let staticEfforts = $state<string[]>([])
  /** The active tab's agent, folder and choices (each tab keeps its own). */
  const form = $derived(activeTab().form)

  onMount(async () => {
    settings = await window.agentDeck.getSettings()
    seedForms(settings)
  })

  // Reload choices whenever the selected agent changes.
  $effect(() => {
    const a = form.agent
    window.agentDeck.getOptions(a).then((o) => {
      staticModels = o.models
      staticEfforts = o.efforts
    })
  })

  /** Switching agent brings back that agent's last model, effort and mode. */
  function selectAgent(a: AgentId) {
    form.agent = a
    form.draft = { ...(settings?.agentConfig[a] ?? defaultConfig()) }
  }

  // While running, the agent's live choices and config win.
  const models = $derived(session.running && session.models.length ? session.models : staticModels)
  const efforts = $derived(session.running && session.efforts.length ? session.efforts : staticEfforts)
  const current = $derived(session.running ? session.config : form.draft)

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

  function change<K extends keyof AgentConfig>(field: K, value: AgentConfig[K]) {
    if (session.running) api.configure({ [field]: value })
    else form.draft[field] = value
  }

  const modes: { id: AgentMode; label: string; title: string }[] = [
    { id: 'auto', label: 'Auto', title: 'Edits files and runs tools on its own' },
    { id: 'plan', label: 'Plan', title: 'Read-only: explores and proposes a plan first (Shift+Tab to switch)' }
  ]

  const stats = $derived(session.stats)
  const ctxPct = $derived(stats.contextMax ? Math.min(100, (stats.contextUsed / stats.contextMax) * 100) : 0)

  const folderName = $derived(form.cwd ? form.cwd.split(/[\\/]/).filter(Boolean).pop() : '')
  const advancedCount = $derived(countSessionOptions(form.advanced[form.agent]))

  async function pick() {
    const f = form
    const dir = await window.agentDeck.pickDirectory()
    if (dir) f.cwd = dir
  }

  // A saved session fixes the agent and folder; continuing it reuses both.
  const replay = $derived(session.replay)
  const locked = $derived(session.running || !!replay)
  $effect(() => {
    if (!replay) return
    form.agent = replay.agent
    form.cwd = replay.cwd
  })

  async function start() {
    const f = form
    if (!f.cwd) await pick()
    if (!f.cwd) return
    f.starting = true
    // Continuing keeps the saved transcript; new turns append below it.
    // Claude may report a new id after a resume, so prefer the live one.
    const resume = replay ? { id: session.sessionId || replay.id, path: replay.path } : undefined
    if (!resume) resetSession()
    const advanced = $state.snapshot(f.advanced[f.agent])
    try {
      await api.start({ agent: f.agent, cwd: f.cwd, ...f.draft, resume, advanced })
      activeTab().started = advanced
      if (settings) {
        settings.agentConfig[f.agent] = { ...f.draft }
        settings.sessionOptions = { ...settings.sessionOptions, [f.agent]: advanced }
      }
    } finally {
      f.starting = false
    }
  }

  async function stop() {
    // Carry the session's final choices into the next start.
    form.draft = { ...session.config }
    if (settings) settings.agentConfig[form.agent] = { ...form.draft }
    await api.stop()
  }

  $effect(() => {
    if (session.running) form.starting = false
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
          aria-checked={form.agent === id}
          class:on={form.agent === id}
          disabled={locked}
          onclick={() => selectAgent(id as AgentId)}>{name}</button
        >
      {/each}
    </div>
  </div>

  <div class="field folder-field">
    <span class="flabel">Project folder</span>
    <button class="folder" onclick={pick} disabled={locked} title={form.cwd || 'Choose a project folder'}>
      {(setup ? form.cwd : folderName) || 'Choose project folder'}
    </button>
  </div>

  <div class="field">
    <span class="flabel" id="mode-label">Mode</span>
    <div class="modes" role="radiogroup" aria-labelledby="mode-label">
      {#each modes as m (m.id)}
        <button
          role="radio"
          aria-checked={current.mode === m.id}
          class:on={current.mode === m.id}
          data-mode={m.id}
          title={m.title}
          onclick={() => current.mode !== m.id && change('mode', m.id)}>{m.label}</button
        >
      {/each}
    </div>
  </div>

  <div class="field pair">
    <ModelPicker
      value={current.model}
      options={modelOptions}
      title={!session.running && form.agent === 'pi' && !models.length ? 'Pi lists its models once the session starts' : ''}
      onchange={(v) => change('model', v)}
    />
    <Select label="Effort" value={current.effort} options={effortOptions} onchange={(v) => change('effort', v)} />
  </div>

  {#if setup}
    <details class="advanced">
      <summary>Advanced{advancedCount ? ` · ${advancedCount} set` : ''}</summary>
      <AdvancedOptions agent={form.agent} bind:options={form.advanced[form.agent]} cwd={form.cwd} />
    </details>
  {/if}

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
    <button class="action primary" onclick={start} disabled={form.starting}>
      {form.starting ? 'Starting…' : replay ? 'Continue session' : 'Start session'}
    </button>
  {/if}

  <button class="gear" onclick={() => settingsDialog.open()} title="Settings" aria-label="Settings">
    <!-- Feather "settings" icon (MIT). -->
    <svg viewBox="0 0 24 24" aria-hidden="true"
      ><circle cx="12" cy="12" r="3" /><path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
      /></svg
    >
    {#if setup}<span>Settings</span>{/if}
  </button>

  {#if setup}
    <SessionHistory cwd={form.cwd} />
  {/if}
</header>

<SettingsDialog bind:this={settingsDialog} onsaved={(s) => (settings = s)} />

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
    /* Centred while it fits; with Advanced open it scrolls instead of clipping its top. */
    justify-content: safe center;
    min-height: 0;
    overflow-y: auto;
    scrollbar-gutter: stable both-edges;
    gap: 18px;
    width: min(516px, 100%);
    box-sizing: border-box;
    margin: 0 auto;
    padding: 24px 28px 10vh;
    border-bottom: none;
  }
  .setup > :global(*) {
    flex-shrink: 0;
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
  .setup .agents button,
  .setup .modes button {
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
  .advanced {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 8px 12px;
  }
  .advanced summary {
    cursor: pointer;
    font-size: 13px;
    color: var(--muted);
  }
  .advanced[open] summary {
    color: var(--text);
  }
  .setup .action {
    margin-top: 6px;
    padding: 10px 16px;
    font-size: 15px;
  }

  .agents,
  .modes {
    display: flex;
    padding: 3px;
    border-radius: var(--radius);
    background: var(--sunken);
    border: 1px solid var(--line);
  }
  .agents button,
  .modes button {
    border: none;
    background: none;
    padding: 4px 14px;
    border-radius: 5px;
    color: var(--muted);
    font-size: 14px;
    white-space: nowrap;
  }
  .agents button.on,
  .modes button.on {
    background: var(--raised);
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  /* Plan mode is the one that changes what the agent may do, so it gets the accent. */
  .modes button.on[data-mode='plan'] {
    color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
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

  .gear {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px;
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: none;
    color: var(--muted);
    font-size: 13px;
  }
  .gear:hover {
    color: var(--text);
    border-color: var(--line);
  }
  .gear svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .setup .gear {
    align-self: center;
    padding: 4px 10px;
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
