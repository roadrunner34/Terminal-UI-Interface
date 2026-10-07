<script lang="ts">
  import { onMount } from 'svelte'
  import TopBar from './components/TopBar.svelte'
  import Transcript from './components/Transcript.svelte'
  import Composer from './components/Composer.svelte'
  import SubagentPanel from './components/SubagentPanel.svelte'
  import StatsBar from './components/StatsBar.svelte'
  import TaskPanel from './components/TaskPanel.svelte'
  import TabBar from './components/TabBar.svelte'
  import { cycleTab, deck, handleEvent, newTab, requestClose, resetSession, session, tabs, view } from './lib/session.svelte'
  import { formatWhen } from '@shared/format'

  onMount(() => {
    const offEvents = window.agentDeck.onEvent(handleEvent)
    // A notification was clicked: show the tab it was about.
    const offFocus = window.agentDeck.onFocusTab((tab) => {
      if (tabs.list.some((t) => t.id === tab)) tabs.active = tab
    })
    return () => {
      offEvents()
      offFocus()
    }
  })

  /** Ctrl+T new tab, Ctrl+W close, Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl+1–9 jump. */
  function onKey(e: KeyboardEvent) {
    if (!e.ctrlKey || e.altKey || e.metaKey) return
    const key = e.key.toLowerCase()
    if (key === 't') newTab()
    else if (key === 'w') requestClose(tabs.active)
    else if (key === 'tab') cycleTab(e.shiftKey ? -1 : 1)
    else if (/^[1-9]$/.test(key)) {
      const t = key === '9' ? tabs.list.at(-1) : tabs.list[Number(key) - 1]
      if (!t) return
      tabs.active = t.id
    } else return
    e.preventDefault()
  }

  const viewing = $derived(view.scope === 'main' ? null : session.subagents[view.scope])
  const blocks = $derived(session.transcripts[view.scope] ?? [])
  // Nothing has happened yet: show the setup form instead of an empty transcript.
  const setup = $derived(!session.running && !session.transcripts.main.length && view.scope === 'main')
</script>

<svelte:window onkeydown={onKey} />

<div class="shell">
  <main class="main">
    <TabBar />
    <TopBar {setup} />

    {#if session.replay && !session.running}
      <div class="saved" role="status">
        <span>
          Saved session from <span title={new Date(session.replay.updatedAt).toLocaleString()}
            >{formatWhen(session.replay.updatedAt)}</span
          >. Continue it to reply.
        </span>
        <button class="back" onclick={() => resetSession()}>New session</button>
      </div>
    {/if}

    {#if viewing}
      <nav class="crumb" aria-label="Transcript">
        <button class="back" onclick={() => (view.scope = 'main')}>Main session</button>
        <span class="sep" aria-hidden="true">/</span>
        <span class="tag">{deck.tags[viewing.id]}</span>
        <span class="here" data-status={viewing.status}>{viewing.label}</span>
        <span class="type">{viewing.agentType}</span>
        {#if viewing.model}
          <span class="type">on <span class="model" title={viewing.model}>{viewing.model}</span></span>
        {/if}
      </nav>
    {/if}

    {#if !setup}
      {#key tabs.active}<Transcript {blocks} scopeKey={view.scope} />{/key}
    {/if}

    {#if session.error}
      <div class="error" role="alert">
        <span>{session.error}</span>
        <button onclick={() => (session.error = null)} aria-label="Dismiss error">Dismiss</button>
      </div>
    {/if}

    {#if !setup}
      {#key tabs.active}<Composer viewingSubagent={!!viewing} />{/key}
    {/if}
  </main>

  <aside class="side" class:tasks={deck.tasks.length > 0}>
    {#if deck.tasks.length}<TaskPanel tasks={deck.tasks} />{/if}
    <SubagentPanel />
    <StatsBar />
  </aside>
</div>

<style>
  .shell {
    display: grid;
    /* 80 / 20. minmax(0, …) stops long nowrap text from widening a column. */
    grid-template-columns: minmax(0, 4fr) minmax(240px, 1fr);
    height: 100%;
  }

  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .side {
    display: grid;
    /* The subagent timeline takes the room; the stats footer takes what it needs. */
    grid-template-rows: minmax(0, 1fr) auto;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    background: var(--sunken);
    border-left: 1px solid var(--line);
  }
  /* The checklist sits above the subagents and takes only what it needs. */
  .side.tasks {
    grid-template-rows: auto minmax(0, 1fr) auto;
  }

  .crumb {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 10px 28px;
    border-bottom: 1px solid var(--line);
    background: var(--raised);
    font-size: 14px;
  }
  .saved {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 28px;
    border-bottom: 1px solid var(--line);
    background: var(--sunken);
    color: var(--muted);
    font-size: 13px;
  }

  .back {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
  }
  .back:hover {
    text-decoration: underline;
  }
  .sep {
    color: var(--muted);
  }
  .tag {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    padding: 0 5px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  .here {
    font-weight: 600;
  }
  .type {
    color: var(--muted);
    font-size: 13px;
  }
  .model {
    color: var(--text);
    font-family: var(--mono);
    font-size: 12.5px;
  }

  .error {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    margin: 0 28px 8px;
    padding: 10px 14px;
    border-left: 3px solid var(--error);
    background: color-mix(in srgb, var(--error) 10%, var(--ink));
    font-size: 14px;
    white-space: pre-wrap;
    max-height: 30vh;
    overflow: auto;
  }
  .error button {
    background: none;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 2px 10px;
    color: var(--muted);
    flex-shrink: 0;
  }
</style>
