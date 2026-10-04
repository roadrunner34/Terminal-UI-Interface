<script lang="ts">
  import { onDestroy } from 'svelte'
  import { formatDuration, shortModel } from '@shared/format'
  import type { Subagent } from '@shared/session'
  import { session, view } from '../lib/session.svelte'

  // One shared clock drives every running card's elapsed timer.
  let now = $state(Date.now())
  const timer = setInterval(() => (now = Date.now()), 1000)
  onDestroy(() => clearInterval(timer))

  const order = { running: 0, error: 1, done: 2 }
  const byStatus = (a: Subagent, b: Subagent) => order[a.status] - order[b.status] || b.startedAt - a.startedAt

  // Workflow lanes have ids "<workflow id>/<lane>"; list them under their
  // workflow, indented, instead of mixed into the top level.
  const subagents = $derived.by(() => {
    const all = Object.values(session.subagents)
    const parentOf = (id: string) => {
      const cut = id.lastIndexOf('/')
      return cut > 0 && session.subagents[id.slice(0, cut)] ? id.slice(0, cut) : null
    }
    const rows: { sub: Subagent; depth: number }[] = []
    const add = (parent: string | null, depth: number) => {
      for (const sub of all.filter((s) => parentOf(s.id) === parent).sort(byStatus)) {
        rows.push({ sub, depth })
        add(sub.id, depth + 1)
      }
    }
    add(null, 0)
    return rows
  })
  const active = $derived(subagents.filter((r) => r.sub.status === 'running').length)
</script>

<section class="panel" aria-label="Subagents">
  <header>
    <h2>Subagents</h2>
    {#if subagents.length}
      <span class="count">{active ? `${active} running` : `${subagents.length} finished`}</span>
    {/if}
  </header>

  <div class="list">
    {#each subagents as { sub, depth } (sub.id)}
      <button
        class="card"
        style:margin-left="{Math.min(depth, 3) * 12}px"
        style:width="calc(100% - {Math.min(depth, 3) * 12}px)"
        data-status={sub.status}
        class:selected={view.scope === sub.id}
        onclick={() => (view.scope = view.scope === sub.id ? 'main' : sub.id)}
        aria-pressed={view.scope === sub.id}
      >
        <span class="top">
          <span class="label">{sub.label}</span>
          <span class="time">{formatDuration((sub.endedAt ?? now) - sub.startedAt)}</span>
        </span>
        <span class="meta">
          <span class="type">
            {sub.agentType}{#if sub.status === 'error'}<span class="failed">, failed</span>{/if}
          </span>
          {#if sub.model}
            <span class="model" title={sub.model}>{shortModel(sub.model)}</span>
          {/if}
        </span>
        <span class="activity">{sub.lastActivity}</span>
      </button>
    {:else}
      <p class="empty">No subagents yet. When the agent delegates work, each subagent shows up here while it runs.</p>
    {/each}
  </div>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 18px 16px 10px;
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .count {
    font-size: 12px;
    color: var(--muted);
  }

  .list {
    flex: 1;
    overflow-y: auto;
    padding: 0 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    width: 100%;
    padding: 9px 10px 9px 14px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: var(--raised);
    overflow: hidden;
  }
  .card:hover {
    border-color: var(--line);
  }
  .card.selected {
    border-color: var(--running);
  }
  /* The signal edge: a status-coloured strip that pulses while running. */
  .card::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    background: var(--muted);
  }
  .card[data-status='running']::before {
    background: var(--running);
    animation: signal 1.4s ease-in-out infinite;
  }
  .card[data-status='done']::before {
    background: var(--done);
  }
  .card[data-status='error']::before {
    background: var(--error);
  }
  .card[data-status='done'] {
    opacity: 0.72;
  }
  .card[data-status='done']:hover,
  .card[data-status='done'].selected {
    opacity: 1;
  }
  @keyframes signal {
    0%,
    100% {
      opacity: 1;
      box-shadow: 0 0 8px var(--running);
    }
    50% {
      opacity: 0.35;
      box-shadow: none;
    }
  }

  .top {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .label {
    font-size: 14px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .time {
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .meta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }
  .type {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .model {
    flex-shrink: 1;
    min-width: 0;
    max-width: 60%;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    font-size: 11.5px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .failed {
    color: var(--error);
  }
  .activity {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 3px;
  }

  .empty {
    margin: 4px 6px;
    font-size: 13px;
    color: var(--muted);
    line-height: 1.5;
  }
</style>
