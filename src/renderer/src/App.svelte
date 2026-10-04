<script lang="ts">
  import { onMount } from 'svelte'
  import TopBar from './components/TopBar.svelte'
  import Transcript from './components/Transcript.svelte'
  import Composer from './components/Composer.svelte'
  import SubagentPanel from './components/SubagentPanel.svelte'
  import StatsBar from './components/StatsBar.svelte'
  import { handleEvent, session, view } from './lib/session.svelte'

  onMount(() => window.agentDeck.onEvent(handleEvent))

  const viewing = $derived(view.scope === 'main' ? null : session.subagents[view.scope])
  const blocks = $derived(session.transcripts[view.scope] ?? [])
</script>

<div class="shell">
  <main class="main">
    <TopBar />

    {#if viewing}
      <nav class="crumb" aria-label="Transcript">
        <button class="back" onclick={() => (view.scope = 'main')}>Main session</button>
        <span class="sep" aria-hidden="true">/</span>
        <span class="here" data-status={viewing.status}>{viewing.label}</span>
        <span class="type">{viewing.agentType}</span>
        {#if viewing.model}
          <span class="type">on <span class="model" title={viewing.model}>{viewing.model}</span></span>
        {/if}
      </nav>
    {/if}

    <Transcript {blocks} scopeKey={view.scope} />

    {#if session.error}
      <div class="error" role="alert">
        <span>{session.error}</span>
        <button onclick={() => (session.error = null)} aria-label="Dismiss error">Dismiss</button>
      </div>
    {/if}

    <Composer viewingSubagent={!!viewing} />
  </main>

  <aside class="side">
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
    /* 90 / 10 split, but never let the stats get too short to read. */
    grid-template-rows: minmax(0, 9fr) minmax(96px, 1fr);
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    background: var(--sunken);
    border-left: 1px solid var(--line);
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
  .back {
    background: none;
    border: none;
    padding: 0;
    color: var(--running);
  }
  .back:hover {
    text-decoration: underline;
  }
  .sep {
    color: var(--muted);
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
