<script lang="ts">
  import { onMount } from 'svelte'
  import type { AgentConfig, AgentId, ModelOption } from '@shared/events'
  import type { AppSettings } from '@shared/api'
  import { resetSession, session } from '../lib/session.svelte'
  import ModelPicker from './ModelPicker.svelte'
  import Select from './Select.svelte'

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

  const modelOptions = $derived(withCurrent(
    [{ value: '', label: 'Default' }, ...models.map((m) => ({ value: m.id, label: m.label }))],
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

  const folderName = $derived(cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : '')

  async function pick() {
    const dir = await window.agentDeck.pickDirectory()
    if (dir) cwd = dir
  }

  async function start() {
    if (!cwd) await pick()
    if (!cwd) return
    starting = true
    resetSession()
    try {
      await window.agentDeck.start({ agent, cwd, ...draft })
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

<header class="bar">
  <div class="agents" role="radiogroup" aria-label="Agent">
    {#each [['claude', 'Claude Code'], ['pi', 'Pi']] as [id, name] (id)}
      <button
        role="radio"
        aria-checked={agent === id}
        class:on={agent === id}
        disabled={session.running}
        onclick={() => (agent = id as AgentId)}>{name}</button
      >
    {/each}
  </div>

  <button class="folder" onclick={pick} disabled={session.running} title={cwd || 'Choose a project folder'}>
    {folderName || 'Choose project folder'}
  </button>

  <ModelPicker
    value={current.model}
    options={modelOptions}
    title={!session.running && agent === 'pi' && !models.length ? 'Pi lists its models once the session starts' : ''}
    onchange={(v) => change('model', v)}
  />
  <Select label="Effort" value={current.effort} options={effortOptions} onchange={(v) => change('effort', v)} />

  <div class="status">
    {#if session.running}
      <span class="dot" class:busy={session.busy}></span>
      <span class="model">{session.model || 'Connected'}</span>
    {:else if starting}
      <span class="model">Starting…</span>
    {/if}
  </div>

  {#if session.running}
    <button class="action" onclick={stop}>End session</button>
  {:else}
    <button class="action primary" onclick={start} disabled={starting}>Start session</button>
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

  .folder {
    background: none;
    border: 1px dashed var(--line);
    border-radius: var(--radius);
    padding: 5px 12px;
    font-size: 14px;
    max-width: 280px;
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
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--muted);
    font-size: 13px;
  }
  .model {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .action {
    border: 1px solid var(--line);
    background: var(--raised);
    border-radius: var(--radius);
    padding: 6px 16px;
    font-size: 14px;
  }
  .action.primary {
    background: var(--running);
    border-color: var(--running);
    color: var(--ink);
    font-weight: 600;
  }
  .action:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
