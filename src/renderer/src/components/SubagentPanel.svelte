<script lang="ts">
  import { onDestroy } from 'svelte'
  import { formatDuration, shortModel } from '@shared/format'
  import { deck, view } from '../lib/session.svelte'
  import StatusGlyph from './StatusGlyph.svelte'

  // One shared clock drives every running card's timer and bar.
  let now = $state(Date.now())
  const timer = setInterval(() => (now = Date.now()), 1000)
  onDestroy(() => clearInterval(timer))

  const rows = $derived(deck.rows)
  const running = $derived(rows.filter((r) => r.sub.status === 'running').length)
  const failed = $derived(rows.filter((r) => r.sub.status === 'error').length)

  // Every bar shares one time axis, from the first launch to now (or to the
  // last finish once nothing is running), so overlap and stragglers show.
  const axis = $derived.by(() => {
    if (!rows.length) return { start: 0, span: 1 }
    const start = Math.min(...rows.map((r) => r.sub.startedAt))
    const end = running ? now : Math.max(...rows.map((r) => r.sub.endedAt ?? now))
    return { start, span: Math.max(end - start, 1000) }
  })
  const pos = (t: number) => ((t - axis.start) / axis.span) * 100

  function summary() {
    const parts = [running && `${running} running`, failed && `${failed} failed`].filter(Boolean)
    return parts.length ? parts.join(', ') : `${rows.length} finished`
  }
</script>

<section class="panel" aria-label="Subagents">
  <header>
    <h2>Subagents</h2>
    {#if rows.length}
      <span class="count">{summary()}</span>
    {/if}
  </header>

  {#if rows.length}
    <div class="axis" aria-hidden="true">
      <span>0s</span>
      <span>{formatDuration(axis.span)}</span>
    </div>
  {/if}

  <div class="list">
    {#each rows as { sub, depth, tag, children } (sub.id)}
      {@const end = sub.endedAt ?? now}
      <button
        class="card"
        data-status={sub.status}
        class:selected={view.scope === sub.id}
        class:linked={view.hovered === sub.id}
        onclick={() => (view.scope = view.scope === sub.id ? 'main' : sub.id)}
        onmouseenter={() => (view.hovered = sub.id)}
        onmouseleave={() => (view.hovered = '')}
        aria-pressed={view.scope === sub.id}
      >
        <span class="body" class:nested={depth > 0} style:--depth={Math.min(depth, 3)}>
          <span class="top">
            <StatusGlyph status={sub.status} />
            <span class="tag">{tag}</span>
            <span class="label">{sub.label}</span>
            <span class="time">{formatDuration(end - sub.startedAt)}</span>
          </span>
          <span class="meta">
            <span class="type">
              {sub.agentType}{#if children}{#if children.running}, {children.running} running{/if}{#if children.error}<span
                    class="failed">, {children.error} failed</span
                  >{/if}{:else if sub.status === 'error'}<span class="failed">, failed</span>{/if}
            </span>
            {#if sub.model}
              <span class="model" title={sub.model}>{shortModel(sub.model)}</span>
            {/if}
          </span>
          {#if sub.lastActivity}
            <span class="activity">{sub.lastActivity}</span>
          {/if}
        </span>
        <span class="track" aria-hidden="true">
          <span
            class="bar"
            class:alert={children?.error}
            style:left="{pos(sub.startedAt)}%"
            style:width="max(3px, {pos(end) - pos(sub.startedAt)}%)"
          ></span>
        </span>
      </button>
    {:else}
      <p class="empty">No subagents yet. When the agent delegates work, each subagent shows up here on a shared timeline while it runs.</p>
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
    padding: 18px 16px 6px;
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

  /* Axis ends line up with each card's track (list 10px + border 1px + padding 11px). */
  .axis {
    display: flex;
    justify-content: space-between;
    padding: 0 22px 6px;
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .list {
    flex: 1;
    overflow-y: auto;
    padding: 0 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 7px;
    text-align: left;
    width: 100%;
    padding: 8px 11px 9px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: var(--raised);
  }
  .card:hover,
  .card.linked {
    border-color: var(--muted);
  }
  .card.selected {
    border-color: var(--accent);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  /* Lanes indent their text under a rail, but their bars stay full width so
     every bar reads against the same axis. */
  .body.nested {
    margin-left: calc((var(--depth) - 1) * 14px + 5px);
    padding-left: 10px;
    border-left: 1px solid var(--line);
  }

  .top {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .tag {
    flex-shrink: 0;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .label {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Finished work recedes by colour, not opacity, so small text keeps AA contrast. */
  .card[data-status='done']:not(.selected) .label {
    color: color-mix(in srgb, var(--text) 78%, var(--raised));
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
    padding-left: 19px;
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
    padding-left: 19px;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The timeline: quarter ticks give the eye a scale to compare bars against. */
  .track {
    position: relative;
    display: block;
    height: 6px;
    border-radius: 3px;
    background:
      linear-gradient(90deg, transparent calc(25% - 0.5px), var(--line) 0 calc(25% + 0.5px), transparent 0 calc(50% - 0.5px), var(--line) 0 calc(50% + 0.5px), transparent 0 calc(75% - 0.5px), var(--line) 0 calc(75% + 0.5px), transparent 0),
      color-mix(in srgb, var(--line) 45%, var(--raised));
  }
  .bar {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 3px;
    background: var(--muted);
    /* Matches the 1s clock, so running bars grow continuously. */
    transition:
      left 1s linear,
      width 1s linear;
  }
  [data-status='running'] .bar {
    background: var(--running);
  }
  [data-status='done'] .bar {
    background: color-mix(in srgb, var(--done) 70%, var(--raised));
  }
  [data-status='error'] .bar {
    background: var(--error);
  }
  /* A parent with a failed lane carries a red cap at its leading edge. */
  .bar.alert {
    box-shadow: inset -3px 0 0 var(--error);
  }

  .empty {
    margin: 4px 6px;
    font-size: 13px;
    color: var(--muted);
    line-height: 1.5;
  }
</style>
