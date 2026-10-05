<script lang="ts">
  import { tick } from 'svelte'
  import type { Block } from '@shared/session'
  import { agent, deck, session } from '../lib/session.svelte'
  import Markdown from './Markdown.svelte'
  import ToolCall from './ToolCall.svelte'

  let { blocks, scopeKey }: { blocks: Block[]; scopeKey: string } = $props()

  type ToolBlock = Extract<Block, { type: 'tool' }>
  // Consecutive tool calls render as one framed group instead of a stack of boxes.
  const items = $derived.by(() => {
    const out: (Exclude<Block, ToolBlock> | { type: 'tools'; id: string; tools: ToolBlock[] })[] = []
    for (const b of blocks) {
      const prev = out[out.length - 1]
      if (b.type !== 'tool') out.push(b)
      else if (prev?.type === 'tools') prev.tools.push(b)
      else out.push({ type: 'tools', id: `g-${b.id}`, tools: [b] })
    }
    return out
  })

  // Say what the agent is doing, not just that it is busy.
  const activity = $derived.by(() => {
    if (session.prompts.length) return 'Waiting for you…'
    const last = blocks[blocks.length - 1]
    if (last?.type === 'tool' && last.status === 'running' && !session.subagents[last.id]) return `Running ${last.name}…`
    // Top-level runs only: a workflow and its lanes count as one.
    const waiting = deck.rows.filter((r) => r.depth === 0 && r.sub.status === 'running').length
    if (waiting) return `Waiting on ${waiting} subagent${waiting === 1 ? '' : 's'}…`
    return 'Working…'
  })

  /** Prompts sent in this session can be forked from (and, with Claude, rewound to) while idle. */
  const canBranch = (b: Block) => scopeKey === 'main' && session.running && !session.busy && b.type === 'user' && !!b.entryId

  let scroller: HTMLDivElement
  let column: HTMLDivElement
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

  // Follow growth of the rendered content, whatever caused it: new blocks,
  // frame-throttled markdown, or a tool call opening.
  $effect(() => {
    const observer = new ResizeObserver(() => {
      if (pinned) scroller.scrollTo({ top: scroller.scrollHeight })
    })
    observer.observe(column)
    return () => observer.disconnect()
  })

  $effect(() => {
    void blocks.length
    if (pinned) tick().then(() => scroller?.scrollTo({ top: scroller.scrollHeight }))
  })
</script>

<div class="scroller" bind:this={scroller} onscroll={onScroll}>
  <div class="column" bind:this={column}>
    {#if blocks.length === 0}
      <div class="empty">
        {#if scopeKey !== 'main'}
          <p>This subagent hasn't reported anything yet.</p>
        {:else if session.running}
          <p>Session started. Describe what you want the agent to do.</p>
        {:else}
          <p>Session ended. Start a new one from the bar above.</p>
        {/if}
      </div>
    {/if}

    {#each items as block (block.id)}
      {#if block.type === 'user'}
        <div class="urow">
          <section class="user">
            {#if block.images?.length}
              <div class="images">
                {#each block.images as img, i (i)}
                  <img src="data:{img.mimeType};base64,{img.data}" alt="Attached image {i + 1}" />
                {/each}
              </div>
            {/if}
            {#if block.text}<p>{block.text}</p>{/if}
          </section>
          {#if canBranch(block)}
            <div class="uactions">
              <button
                onclick={() => agent.fork(block.entryId!)}
                title="Continue from before this message on a new branch. Its text goes back in the message box to edit.">Fork from here</button
              >
              {#if session.agent === 'claude'}
                <button onclick={() => agent.rewind(block.entryId!)} title="Put files back as they were before this message (asks first)"
                  >Restore files</button
                >
              {/if}
            </div>
          {/if}
        </div>
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
            <div class="md"><Markdown text={block.text} /></div>
          {/if}
        </section>
      {:else}
        <div class="tools">
          {#each block.tools as tool (tool.id)}
            <ToolCall {tool} subagent={session.subagents[tool.id]} />
          {/each}
        </div>
      {/if}
    {/each}

    {#if session.busy && scopeKey === 'main'}
      <div class="working" aria-live="polite">{activity}</div>
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
  .empty p {
    margin: 0;
  }

  /* Your turn: a quiet raised slab, so blue stays reserved for "running". */
  .user {
    align-self: flex-start;
    max-width: 100%;
    padding: 9px 14px;
    margin-top: 10px;
    background: var(--raised);
    border-radius: var(--radius);
  }
  .urow {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
  }
  .urow .user {
    margin-top: 0;
    min-width: 0;
  }
  /* Out of the way until the message is hovered or focused. */
  .uactions {
    flex-shrink: 0;
    display: flex;
    gap: 6px;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .urow:hover .uactions,
  .uactions:focus-within {
    opacity: 1;
  }
  .uactions button {
    padding: 2px 9px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .uactions button:hover {
    color: var(--text);
    border-color: var(--muted);
  }
  .images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }
  .images img {
    max-width: 220px;
    max-height: 160px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
  }
  .images:last-child {
    margin-bottom: 0;
  }
  .user p {
    margin: 0;
    white-space: pre-wrap;
    font-weight: 500;
  }

  .tools {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--raised);
    overflow: hidden;
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
    color: var(--accent);
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
