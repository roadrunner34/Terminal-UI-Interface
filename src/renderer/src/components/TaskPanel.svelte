<script lang="ts">
  import type { AgentTask } from '@shared/tools'

  /** The agent's own checklist (Claude's TaskCreate/TaskUpdate or TodoWrite). */
  let { tasks }: { tasks: AgentTask[] } = $props()

  const done = $derived(tasks.filter((t) => t.status === 'completed').length)
  const word = { pending: 'To do', in_progress: 'In progress', completed: 'Done' }
</script>

<section class="panel" aria-label="Tasks">
  <header>
    <h2>Tasks</h2>
    <span class="count">{done} of {tasks.length} done</span>
  </header>
  <ol class="list">
    {#each tasks as t (t.id)}
      <li data-status={t.status}>
        <span class="box" aria-hidden="true">
          {#if t.status === 'completed'}
            <svg viewBox="0 0 12 12"><path d="M2.5 6.5l2.2 2.2L9.5 3.8" /></svg>
          {/if}
        </span>
        <span class="sr-only">{word[t.status]}:</span>
        <span class="text" title={t.subject}>{t.status === 'in_progress' ? (t.activeForm ?? t.subject) : t.subject}</span>
      </li>
    {/each}
  </ol>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    max-height: 38vh;
    border-bottom: 1px solid var(--line);
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
    font-variant-numeric: tabular-nums;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0 16px 12px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 13px;
  }
  li {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    line-height: 1.4;
  }
  .box {
    flex-shrink: 0;
    display: inline-grid;
    place-items: center;
    width: 13px;
    height: 13px;
    margin-top: 2px;
    border: 1.5px solid var(--muted);
    border-radius: 3px;
  }
  li[data-status='in_progress'] .box {
    border-color: var(--running);
    background: color-mix(in srgb, var(--running) 25%, transparent);
  }
  li[data-status='in_progress'] .text {
    color: var(--running);
    font-weight: 500;
  }
  li[data-status='completed'] .box {
    border-color: var(--done);
    color: var(--done);
  }
  li[data-status='completed'] .text {
    color: var(--muted);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--muted) 60%, transparent);
  }
  svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }
  .text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
