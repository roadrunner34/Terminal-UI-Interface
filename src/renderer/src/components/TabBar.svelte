<script lang="ts">
  import { newTab, requestClose, tabs, type Tab } from '../lib/session.svelte'

  const NAMES = { claude: 'Claude Code', pi: 'Pi' }

  function label(t: Tab) {
    const s = t.state
    if (!s.running && !s.transcripts.main.length) return 'New session'
    const cwd = s.replay?.cwd ?? t.form.cwd
    const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
    return folder || NAMES[s.agent ?? t.form.agent]
  }

  /** What the tab's dot says, most urgent first. */
  function status(t: Tab): { key: string; word: string } {
    const s = t.state
    if (s.prompts.length) return { key: 'needs', word: 'Needs you' }
    if (s.error) return { key: 'error', word: 'Error' }
    if (s.busy) return { key: 'busy', word: 'Working' }
    if (s.running) return { key: 'idle', word: 'Idle' }
    return { key: 'off', word: 'Not running' }
  }
</script>

<div class="tabs" role="tablist" aria-label="Sessions">
  {#each tabs.list as t (t.id)}
    {@const st = status(t)}
    <div class="tab" class:active={t.id === tabs.active} data-status={st.key}>
      <button
        role="tab"
        class="pick"
        aria-selected={t.id === tabs.active}
        title="{label(t)}: {st.word}"
        onclick={() => (tabs.active = t.id)}
      >
        <span class="dot" aria-hidden="true"></span>
        <span class="agent">{NAMES[t.state.agent ?? t.form.agent]}</span>
        <span class="name">{label(t)}</span>
        <span class="sr-only">, {st.word}</span>
      </button>
      <button
        class="close"
        onclick={() => requestClose(t.id)}
        aria-label="Close {label(t)}"
        title={t.state.running ? 'End this session and close the tab' : 'Close tab'}>×</button
      >
    </div>
  {/each}
  <button class="new" onclick={newTab} aria-label="New session tab" title="New session (Ctrl+T)">+</button>
</div>

<style>
  .tabs {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 6px 12px 0;
    border-bottom: 1px solid var(--line);
    background: var(--sunken);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    display: flex;
    align-items: center;
    min-width: 0;
    max-width: 240px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: var(--radius) var(--radius) 0 0;
    color: var(--muted);
  }
  .tab:hover {
    color: var(--text);
  }
  .tab.active {
    background: var(--ink);
    border-color: var(--line);
    color: var(--text);
    /* Sit over the strip's bottom border so the active tab joins the page. */
    margin-bottom: -1px;
    padding-bottom: 1px;
  }
  button {
    background: none;
    border: none;
    color: inherit;
  }
  .pick {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    padding: 6px 4px 6px 12px;
    font-size: 13px;
  }
  .agent {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--muted);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--line);
  }
  [data-status='idle'] .dot {
    background: var(--done);
  }
  [data-status='busy'] .dot {
    background: var(--running);
    animation: pulse 1.2s ease-in-out infinite;
  }
  [data-status='needs'] .dot {
    background: var(--warn);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 30%, transparent);
  }
  [data-status='error'] .dot {
    background: var(--error);
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  .close {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    margin-right: 6px;
    padding: 0;
    border-radius: var(--radius-sm);
    font-size: 15px;
    line-height: 1;
    color: var(--muted);
    opacity: 0;
  }
  .tab:hover .close,
  .tab.active .close,
  .close:focus-visible {
    opacity: 1;
  }
  .close:hover {
    background: var(--raised);
    color: var(--text);
  }
  .new {
    flex-shrink: 0;
    align-self: center;
    width: 26px;
    height: 26px;
    margin-left: 4px;
    padding: 0;
    border-radius: var(--radius-sm);
    color: var(--muted);
    font-size: 17px;
    line-height: 1;
  }
  .new:hover {
    background: var(--raised);
    color: var(--text);
  }
</style>
