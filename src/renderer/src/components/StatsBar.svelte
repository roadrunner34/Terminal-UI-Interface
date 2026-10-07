<script lang="ts">
  import type { McpAction, McpServer } from '@shared/events'
  import { contextLevel, formatTokens, summarizeSessionOptions } from '@shared/format'
  import { activeTab, agent, session } from '../lib/session.svelte'

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

  // Claude can say where the context goes; asked for each time the breakdown opens.
  const usage = $derived(session.contextUsage)
  const canBreakdown = $derived(session.running && session.agent === 'claude')

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

  // The advanced options this session started with; fixed until it ends.
  const fixed = $derived(summarizeSessionOptions(activeTab().started))

  // Claude can act on its servers; Pi's list is read-only (its /mcp changes last one session).
  const mcpActs = $derived(session.running && session.agent === 'claude')
  let mcpOpen = $state<Record<string, boolean>>({})
  /** The server whose Disable is waiting for a second click. */
  let mcpConfirm = $state<string | null>(null)

  function mcpActions(m: McpServer): { action: McpAction; label: string }[] {
    if (!mcpActs) return []
    switch (m.status) {
      case 'failed':
        return [{ action: 'reconnect', label: 'Reconnect' }]
      case 'needs-auth':
        return [{ action: 'auth', label: 'Sign in' }]
      case 'disabled':
        return [{ action: 'enable', label: 'Enable' }]
      case 'connected':
        return [
          ...(m.transport === 'http' || m.transport === 'sse' ? [{ action: 'logout' as const, label: 'Sign out' }] : []),
          { action: 'disable', label: 'Disable' }
        ]
      default:
        return []
    }
  }

  function act(m: McpServer, action: McpAction) {
    // Claude writes the enabled state to the user's settings, so confirm first.
    if (action === 'disable' && mcpConfirm !== m.name) {
      mcpConfirm = m.name
      return
    }
    mcpConfirm = null
    agent.mcp(action, m.name)
  }

  function where(m: McpServer): string {
    return [m.source && m.source !== m.scope ? m.source : '', m.scope ?? '', m.version ? `v${m.version}` : '']
      .filter(Boolean)
      .join(' · ')
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
      {#if canBreakdown}
        <button class="link" popovertarget="ctx-pop" onclick={() => agent.contextUsage()} title="See where the context goes"
          >Context</button
        >
      {:else}
        <span>Context</span>
      {/if}
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

  {#if canBreakdown}
    <div id="ctx-pop" class="pop" popover>
      <h3>Context window{usage ? `: ${formatTokens(usage.total)} of ${formatTokens(usage.max)}` : ''}</h3>
      {#if usage}
        <ul class="cats">
          {#each usage.categories as c (c.name)}
            <li data-kind={c.kind}>
              <span class="cname">{c.name}</span>
              <span class="cnum">{formatTokens(c.tokens)}</span>
              <span class="cbar"><span style:width="{usage.max ? Math.min(100, (c.tokens / usage.max) * 100) : 0}%"></span></span>
            </li>
          {/each}
        </ul>
        <p class="pnote">Deferred items load only when used and don't take up context until then.</p>
      {:else}
        <p class="pnote">Asking Claude…</p>
      {/if}
    </div>
  {/if}

  <div class="row" title={cacheTip}>
    <span>Tokens</span>
    <span class="num">{formatTokens(s.inputTokens + s.cacheRead + s.cacheWrite)} in, {formatTokens(s.outputTokens)} out</span>
  </div>
  {#if session.mcp.length}
    <div class="row">
      <span>MCP</span>
      <button
        class="mcp num"
        data-level={mcpLevel}
        popovertarget="mcp-list"
        title="Show each server's status"
        onclick={() => {
          mcpConfirm = null
          if (session.running) agent.mcp('status')
        }}
      >
        {mcpUp} of {session.mcp.length} connected
      </button>
    </div>
    <div id="mcp-list" class="mcp-pop" popover>
      <h3>MCP servers</h3>
      <ul>
        {#each session.mcp as m (m.name)}
          {@const details = !!(m.tools?.length || where(m))}
          <li>
            <div class="mrow">
              <span class="mdot" data-tone={m.busy ? 'busy' : mcpTone(m.status)}></span>
              {#if details}
                <button
                  class="mname link"
                  title={m.name}
                  aria-expanded={!!mcpOpen[m.name]}
                  onclick={() => (mcpOpen[m.name] = !mcpOpen[m.name])}>{m.name}</button
                >
              {:else}
                <span class="mname" title={m.name}>{m.name}</span>
              {/if}
              <span class="mstatus" title={m.error}>{m.error ?? m.status.replace('-', ' ')}</span>
              {#each mcpActions(m) as a (a.action)}
                <button class="mact" disabled={m.busy} onclick={() => act(m, a.action)}>
                  {mcpConfirm === m.name && a.action === 'disable' ? 'Confirm' : a.label}
                </button>
              {/each}
            </div>
            {#if mcpConfirm === m.name}
              <p class="mnote">Disabling is saved to your Claude settings, not just this session.</p>
            {/if}
            {#if details && mcpOpen[m.name]}
              <div class="mdetail">
                {#if where(m)}<span class="mwhere">{where(m)}</span>{/if}
                {#if m.tools?.length}
                  <ul class="mtools">
                    {#each m.tools as t (t.name)}
                      <li>{t.name}{#if t.readOnly}<span class="ro">read-only</span>{/if}</li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if session.agent === 'pi'}
        <p class="pnote">Read-only here. Use /mcp in Pi, or <code>pi mcp</code> in a terminal, to change servers.</p>
      {/if}
    </div>
  {/if}
  {#if session.running && fixed}
    <div class="row" title="Set when the session started. Change them under Advanced in a new session.">
      <span>Options</span>
      <span class="num opts">{fixed}</span>
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
  .link {
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    color: inherit;
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }
  .link:hover {
    color: var(--text);
  }
  .pop,
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
  .pop h3,
  .mcp-pop h3 {
    margin: 0 0 6px;
    font-size: 13px;
    font-weight: 600;
  }
  .cats {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 13px;
    display: grid;
    grid-template-columns: 1fr auto;
    column-gap: 10px;
    row-gap: 2px;
  }
  .cats li {
    display: contents;
  }
  .cname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cnum {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .cbar {
    grid-column: 1 / -1;
    height: 4px;
    margin-bottom: 5px;
    border-radius: 2px;
    background: var(--line);
    overflow: hidden;
  }
  .cbar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  [data-kind='deferred'] .cname,
  [data-kind='deferred'] .cnum,
  [data-kind='free'] .cname,
  [data-kind='free'] .cnum {
    color: var(--muted);
  }
  [data-kind='deferred'] .cbar span {
    background: var(--muted);
  }
  [data-kind='free'] .cbar span {
    background: var(--done);
  }
  .pnote {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
  .mcp-pop ul {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 13px;
  }
  .mcp-pop > ul > li {
    padding: 3px 0;
  }
  .mrow {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
  }
  .mname.link {
    flex: 1;
    min-width: 0;
    text-align: left;
    color: var(--text);
  }
  .mact {
    flex-shrink: 0;
    padding: 1px 8px;
    font-size: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
  }
  .mact:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--muted);
  }
  .mact:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .mnote {
    margin: 2px 0 2px 15px;
    font-size: 12px;
    color: var(--warn);
  }
  .mdetail {
    margin: 2px 0 4px 15px;
    font-size: 12px;
    color: var(--muted);
  }
  .mwhere {
    display: block;
    margin-bottom: 2px;
  }
  .mtools {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 160px;
    overflow-y: auto;
    font-family: var(--mono);
  }
  .mtools li {
    padding: 1px 0;
    color: var(--text);
  }
  .ro {
    margin-left: 6px;
    font-family: inherit;
    font-size: 11px;
    color: var(--muted);
  }
  .mdot[data-tone='busy'] {
    background: var(--accent);
    animation: mpulse 0.9s ease-in-out infinite alternate;
  }
  @keyframes mpulse {
    from {
      opacity: 0.3;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .mdot[data-tone='busy'] {
      animation: none;
    }
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

  .opts {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
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
