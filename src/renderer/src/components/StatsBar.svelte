<script lang="ts">
  import { formatTokens } from '@shared/format'
  import { session } from '../lib/session.svelte'

  const s = $derived(session.stats)
  const pct = $derived(s.contextMax ? Math.min(100, (s.contextUsed / s.contextMax) * 100) : 0)
  const level = $derived(pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low')
  const cacheTip = $derived(`Cache read ${formatTokens(s.cacheRead)}, cache write ${formatTokens(s.cacheWrite)}`)
</script>

<section class="stats" aria-label="Session stats">
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
    <div
      class="meter"
      role="meter"
      aria-label="Context window used"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(pct)}
    >
      <div class="fill" style:width="{pct}%"></div>
    </div>
  </div>

  <div class="row" title={cacheTip}>
    <span>Tokens</span>
    <span class="num">{formatTokens(s.inputTokens + s.cacheRead + s.cacheWrite)} in, {formatTokens(s.outputTokens)} out</span>
  </div>
  <div class="row">
    <span>Cost</span>
    <span class="num cost">${s.costUsd.toFixed(s.costUsd < 1 ? 3 : 2)}</span>
  </div>
</section>

<style>
  .stats {
    border-top: 1px solid var(--line);
    padding: 10px 16px 12px;
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

  .meter {
    margin-top: 4px;
    height: 5px;
    border-radius: 3px;
    background: var(--line);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--done);
    transition: width 0.4s ease, background-color 0.4s;
  }
  [data-level='mid'] .fill {
    background: var(--warn);
  }
  [data-level='high'] .fill {
    background: var(--error);
  }
  [data-level='high'] .num {
    color: var(--error);
  }
</style>
