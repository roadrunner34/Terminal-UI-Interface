<script lang="ts">
  import { contextLevel, formatTokens } from '@shared/format'
  import { agent, session } from '../lib/session.svelte'

  const s = $derived(session.stats)
  const pct = $derived(s.contextMax ? Math.min(100, (s.contextUsed / s.contextMax) * 100) : 0)
  const level = $derived(contextLevel(pct))
  const cacheTip = $derived(`Cache read ${formatTokens(s.cacheRead)}, cache write ${formatTokens(s.cacheWrite)}`)

  // A retry counts down to its next attempt; tick only while one is pending.
  const retry = $derived(session.retry)
  let now = $state(Date.now())
  $effect(() => {
    if (!retry) return
    now = Date.now()
    const timer = setInterval(() => (now = Date.now()), 500)
    return () => clearInterval(timer)
  })
  const retryIn = $derived(retry ? Math.max(0, Math.ceil((retry.at - now) / 1000)) : 0)

  // Compacting needs an idle agent; the button turns amber once context passes 70%.
  const canCompact = $derived(session.running && !session.busy && s.contextUsed > 0)

  // MCP health: how many servers connected, and whether any need attention.
  const mcpUp = $derived(session.mcp.filter((m) => m.status === 'connected').length)
  const mcpLevel = $derived(
    session.mcp.some((m) => mcpTone(m.status) === 'bad') ? 'bad' : session.mcp.some((m) => mcpTone(m.status) === 'warn') ? 'warn' : 'ok'
  )
  function mcpTone(status: string): 'ok' | 'warn' | 'bad' | 'wait' {
    if (status === 'connected') return 'ok'
    if (status === 'pending') return 'wait'
    return status === 'needs-auth' || status === 'disabled' ? 'warn' : 'bad'
  }
</script>

<section class="stats" aria-label="Session stats">
  {#if retry}
    <div class="row retry" role="status" title={retry.reason}>
      <span>Retrying{retry.max ? ` ${retry.attempt}/${retry.max}` : ''}</span>
      <span class="num">{retryIn ? `in ${retryIn}s` : 'now'} · {retry.reason}</span>
    </div>
  {/if}
  <div class="context" data-level={level}>
    <div class="row">
      <span>Context</span>
      <span class="num">
        {#if s.contextMax}
          {formatTokens(s.contextUsed)} / {formatTokens(s.contextMax)}
        {:else if s.contextUsed}
          {formatTokens(s.contextUsed)}
        {:else}
          –
        {/if}
      </span>
    </div>
    {#if session.running}
      <button
        class="compact"
        class:suggest={level !== 'low'}
        disabled={!canCompact}
        onclick={() => agent.compact()}
        title={session.busy ? 'Available when the agent is idle' : 'Summarize the conversation so far to free context'}
        >Compact</button
      >
    {/if}
  </div>

  <div class="row" title={cacheTip}>
    <span>Tokens</span>
    <span class="num">{formatTokens(s.inputTokens + s.cacheRead + s.cacheWrite)} in, {formatTokens(s.outputTokens)} out</span>
  </div>
  {#if session.mcp.length}
    <div class="row">
      <span>MCP</span>
      <button class="mcp num" data-level={mcpLevel} popovertarget="mcp-list" title="Show each server's status">
        {mcpUp} of {session.mcp.length} connected
      </button>
    </div>
    <div id="mcp-list" class="mcp-pop" popover>
      <h3>MCP servers</h3>
      <ul>
        {#each session.mcp as m (m.name)}
          <li>
            <span class="mdot" data-tone={mcpTone(m.status)}></span>
            <span class="mname" title={m.name}>{m.name}</span>
            <span class="mstatus" title={m.error}>{m.error ?? m.status.replace('-', ' ')}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  <div class="row">
    <span>Cost</span>
    <span class="num cost">${s.costUsd.toFixed(s.costUsd < 1 ? 3 : 2)}</span>
  </div>
</section>

<style>
  .stats {
    border-top: 1px solid var(--line);
    padding: 12px 16px 14px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 5px;
    font-size: 12.5px;
    color: var(--muted);
    min-height: 0;
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .num {
    color: var(--text);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .cost {
    font-weight: 600;
  }

  [data-level='high'] .num {
    color: var(--error);
  }

  .context {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .compact {
    align-self: flex-end;
    padding: 2px 10px;
    font-size: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
  }
  .compact:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--muted);
  }
  .compact.suggest:not(:disabled) {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 55%, var(--line));
  }
  .compact:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .mcp {
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }
  .mcp[data-level='warn'] {
    color: var(--warn);
  }
  .mcp[data-level='bad'] {
    color: var(--error);
  }
  .mcp-pop {
    position: fixed;
    inset: auto 16px 150px auto;
    margin: 0;
    width: min(380px, calc(100vw - 32px));
    max-height: 60vh;
    overflow-y: auto;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--raised);
    color: var(--text);
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.35);
  }
  .mcp-pop h3 {
    margin: 0 0 6px;
    font-size: 13px;
    font-weight: 600;
  }
  .mcp-pop ul {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 13px;
  }
  .mcp-pop li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
  }
  .mdot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--muted);
  }
  .mdot[data-tone='ok'] {
    background: var(--done);
  }
  .mdot[data-tone='warn'] {
    background: var(--warn);
  }
  .mdot[data-tone='bad'] {
    background: var(--error);
  }
  .mname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mstatus {
    flex-shrink: 0;
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }

  .retry span:first-child {
    color: var(--warn);
  }
  .retry .num {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
