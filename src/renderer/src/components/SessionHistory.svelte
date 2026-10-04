<script lang="ts">
  import type { SessionSummary } from '@shared/api'
  import { formatWhen } from '@shared/format'
  import { openHistory, session } from '../lib/session.svelte'

  /** Saved sessions from both agents for the chosen folder, shown on the setup screen. */
  let { cwd }: { cwd: string } = $props()

  let sessions = $state<SessionSummary[]>([])
  let opening = $state('')

  $effect(() => {
    const dir = cwd
    sessions = []
    if (!dir) return
    let current = true
    window.agentDeck
      .listSessions(dir)
      .then((list) => {
        if (current) sessions = list
      })
      .catch(() => {})
    return () => {
      current = false
    }
  })

  async function open(s: SessionSummary) {
    opening = s.path
    try {
      await openHistory(s)
    } catch (err) {
      session.error = err instanceof Error ? err.message : String(err)
    } finally {
      opening = ''
    }
  }

  const agentName = { claude: 'Claude Code', pi: 'Pi' }
</script>

{#if sessions.length}
  <section class="history" aria-labelledby="history-title">
    <h2 id="history-title">Previous sessions</h2>
    <ul>
      {#each sessions as s (s.path)}
        <li>
          <button onclick={() => open(s)} disabled={!!opening} title={s.title}>
            <span class="agent">{agentName[s.agent]}</span>
            <span class="title">{s.title}</span>
            <span class="when" title={new Date(s.updatedAt).toLocaleString()}>
              {opening === s.path ? 'Opening…' : formatWhen(s.updatedAt)}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .history {
    margin-top: 14px;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 13px;
    font-weight: 400;
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 34vh;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--sunken);
  }
  li + li {
    border-top: 1px solid var(--line);
  }
  button {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    text-align: left;
    font-size: 14px;
  }
  button:hover:not(:disabled) {
    background: var(--raised);
  }
  button:disabled {
    cursor: default;
  }
  .agent {
    flex-shrink: 0;
    width: 7.5em;
    font-size: 12px;
    color: var(--muted);
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
</style>
