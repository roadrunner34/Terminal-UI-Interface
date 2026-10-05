<script lang="ts">
  import { newTab, requestClose, tabs, type Tab } from '../lib/session.svelte'

  const NAMES = { claude: 'Claude Code', pi: 'Pi' }

  function label(t: Tab) {
    const s = t.state
    if (s.title) return s.title
    if (!s.running && !s.transcripts.main.length) return 'New session'
    const cwd = s.replay?.cwd ?? t.form.cwd
    const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
    return folder || NAMES[s.agent ?? t.form.agent]
  }

  // Renaming happens in place: the tab's name becomes a text field.
  let renaming = $state('')
  let newName = $state('')
  let menu = $state<HTMLElement>()

  function startRename(t: Tab) {
    menu?.hidePopover()
    newName = label(t)
    renaming = t.id
  }

  function finishRename(t: Tab, save: boolean) {
    if (renaming !== t.id) return
    renaming = ''
    const name = newName.trim()
    if (!save || !name || name === label(t)) return
    // A running agent records the name in its session; the tab updates when it confirms.
    if (t.state.running) window.agentDeck.rename(t.id, name)
    else t.state.title = name
  }

  function focusAll(el: HTMLInputElement) {
    el.focus()
    el.select()
  }

  const active = $derived(tabs.list.find((t) => t.id === tabs.active))

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
      {#if renaming === t.id}
        <span class="pick">
          <span class="dot" aria-hidden="true"></span>
          <input
            class="rename"
            bind:value={newName}
            use:focusAll
            aria-label="Session name"
            onkeydown={(e) => {
              if (e.key === 'Enter') finishRename(t, true)
              else if (e.key === 'Escape') finishRename(t, false)
            }}
            onblur={() => finishRename(t, true)}
          />
        </span>
      {:else}
        <button
          role="tab"
          class="pick"
          aria-selected={t.id === tabs.active}
          title="{label(t)}: {st.word}. Double-click to rename."
          onclick={() => (tabs.active = t.id)}
          ondblclick={() => startRename(t)}
        >
          <span class="dot" aria-hidden="true"></span>
          <span class="agent">{NAMES[t.state.agent ?? t.form.agent]}</span>
          <span class="name">{label(t)}</span>
          <span class="sr-only">, {st.word}</span>
        </button>
      {/if}
      {#if t.id === tabs.active && renaming !== t.id}
        <button class="more" popovertarget="tab-menu" aria-label="Session actions" title="Rename or export">⋯</button>
      {/if}
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

<div id="tab-menu" class="menu" popover bind:this={menu} role="menu">
  {#if active}
    <button role="menuitem" onclick={() => startRename(active)}>Rename…</button>
    <button
      role="menuitem"
      disabled={!active.state.running}
      title={active.state.running ? '' : 'Start or continue the session to export it'}
      onclick={() => {
        menu?.hidePopover()
        window.agentDeck.exportSession(active.id)
      }}
      >Export{active.state.agent === 'pi' ? ' as HTML' : ' transcript'}…</button
    >
  {/if}
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
  .rename {
    width: 160px;
    padding: 1px 6px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--raised);
    color: var(--text);
    font: inherit;
    font-size: 13px;
  }
  /* The menu hangs from the active tab's ⋯ button. */
  .more {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: var(--radius-sm);
    color: var(--muted);
    anchor-name: --tab-menu;
  }
  .more:hover {
    background: var(--raised);
    color: var(--text);
  }
  .menu {
    position-anchor: --tab-menu;
    inset: auto;
    top: anchor(bottom);
    left: anchor(left);
    margin: 4px 0 0;
    min-width: 170px;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--raised);
    color: var(--text);
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.35);
  }
  .menu button {
    display: block;
    width: 100%;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    text-align: left;
    font-size: 13px;
  }
  .menu button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }
  .menu button:disabled {
    color: var(--muted);
    cursor: default;
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
