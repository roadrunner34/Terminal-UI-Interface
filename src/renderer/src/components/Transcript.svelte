<script lang="ts">
  import { tick } from 'svelte'
  import type { Block } from '@shared/session'
  import { renderMarkdown } from '../lib/markdown'
  import { session } from '../lib/session.svelte'
  import ToolCall from './ToolCall.svelte'

  let { blocks, scopeKey }: { blocks: Block[]; scopeKey: string } = $props()

  let scroller: HTMLDivElement
  let pinned = $state(true)

  function onScroll() {
    // Follow new output only while the user is at (or near) the bottom.
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60
  }

  // Re-pin when switching between main and a subagent.
  $effect(() => {
    scopeKey
    pinned = true
  })

  $effect(() => {
    // Track content changes by serializing the last block's size.
    const last = blocks[blocks.length - 1]
    void blocks.length
    void (last && (last.type === 'tool' ? last.output.length + last.status : last.text.length))
    if (pinned) tick().then(() => scroller?.scrollTo({ top: scroller.scrollHeight }))
  })
</script>

<div class="scroller" bind:this={scroller} onscroll={onScroll}>
  <div class="column">
    {#if blocks.length === 0}
      <div class="empty">
        {#if scopeKey !== 'main'}
          <p>This subagent hasn't reported anything yet.</p>
        {:else if session.running}
          <p>Session started. Describe what you want the agent to do.</p>
        {:else}
          <h1>Agent Deck</h1>
          <p>Pick an agent and a project folder, then start a session. Subagents appear on the right as they launch. Click one to follow its work.</p>
        {/if}
      </div>
    {/if}

    {#each blocks as block (block.id)}
      {#if block.type === 'user'}
        <section class="user">
          <p>{block.text}</p>
        </section>
      {:else if block.type === 'notice'}
        <p class="notice">{block.text}</p>
      {:else if block.type === 'assistant'}
        <section class="assistant">
          {#if block.thinking}
            <details class="thinking">
              <summary>Thinking</summary>
              <p>{block.thinking}</p>
            </details>
          {/if}
          {#if block.text.trim()}
            <div class="md">{@html renderMarkdown(block.text)}</div>
          {/if}
        </section>
      {:else}
        <ToolCall tool={block} subagent={session.subagents[block.id]} />
      {/if}
    {/each}

    {#if session.busy && scopeKey === 'main'}
      <div class="working" aria-live="polite">Working…</div>
    {/if}
  </div>
</div>

<style>
  .scroller {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .column {
    max-width: 860px;
    margin: 0 auto;
    padding: 28px 28px 40px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .empty {
    margin-top: 12vh;
    color: var(--muted);
    max-width: 52ch;
  }
  .empty h1 {
    color: var(--text);
    font-size: 30px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0 0 8px;
  }
  .empty p {
    margin: 0;
  }

  .user {
    border-left: 3px solid var(--running);
    padding: 2px 0 2px 14px;
    margin-top: 10px;
  }
  .user p {
    margin: 0;
    white-space: pre-wrap;
    font-weight: 500;
  }

  .assistant {
    min-width: 0;
  }

  .notice {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 4px 0;
    font-size: 13px;
    color: var(--muted);
  }
  .notice::before,
  .notice::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  .md :global(p) {
    margin: 0 0 0.75em;
  }
  .md :global(:last-child) {
    margin-bottom: 0;
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3) {
    font-size: 1.05em;
    font-weight: 600;
    margin: 1.1em 0 0.4em;
  }
  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.4em;
    margin: 0 0 0.75em;
  }
  .md :global(a) {
    color: var(--running);
  }
  .md :global(:not(pre) > code) {
    background: var(--raised);
    padding: 1px 5px;
    border-radius: var(--radius-sm);
  }
  .md :global(pre) {
    background: var(--sunken) !important;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 12px 14px;
    overflow-x: auto;
    margin: 0 0 0.75em;
    line-height: 1.45;
  }
  .md :global(table) {
    border-collapse: collapse;
    margin-bottom: 0.75em;
  }
  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--line);
    padding: 4px 10px;
  }

  .thinking {
    color: var(--muted);
    font-size: 14px;
    margin-bottom: 8px;
  }
  .thinking summary {
    cursor: pointer;
  }
  .thinking p {
    white-space: pre-wrap;
    margin: 6px 0 0;
    padding-left: 12px;
    border-left: 1px solid var(--line);
  }

  .working {
    color: var(--muted);
    font-size: 14px;
    animation: breathe 1.6s ease-in-out infinite;
  }
  @keyframes breathe {
    50% {
      opacity: 0.4;
    }
  }
</style>
