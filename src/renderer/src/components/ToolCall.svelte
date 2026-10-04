<script lang="ts">
  import type { Block, Subagent } from '@shared/session'
  import { summarizeInput } from '@shared/session'
  import { deck, view } from '../lib/session.svelte'
  import StatusGlyph from './StatusGlyph.svelte'

  let { tool, subagent }: { tool: Extract<Block, { type: 'tool' }>; subagent?: Subagent } = $props()
  let open = $state(false)

  const summary = $derived(summarizeInput(tool.input))
  const inputJson = $derived(JSON.stringify(tool.input, null, 2))
  const tag = $derived(subagent ? deck.tags[subagent.id] : '')
</script>

<!-- Rows sit inside a group in the transcript; the group draws the frame. -->
<div
  class="tool"
  data-status={tool.status}
  class:linked={subagent && view.hovered === subagent.id}
  role="group"
  aria-label="{tool.name} tool call"
  onmouseenter={() => subagent && (view.hovered = subagent.id)}
  onmouseleave={() => subagent && (view.hovered = '')}
>
  <div class="head">
    <button class="chev" class:open onclick={() => (open = !open)} aria-expanded={open} aria-label="Show details">
      <span aria-hidden="true">›</span>
    </button>
    <!-- A subagent call opens that subagent; any other call toggles its details. -->
    <button
      class="main"
      onclick={() => (subagent ? (view.scope = subagent.id) : (open = !open))}
      aria-label={subagent ? `Open subagent ${tag}: ${subagent.label}` : undefined}
    >
      <StatusGlyph status={tool.status} />
      <span class="name">{tool.name}</span>
      {#if tag}<span class="tag">{tag}</span>{/if}
      <span class="summary">{summary}</span>
      {#if tool.status === 'error'}<span class="state">failed</span>{/if}
      {#if subagent}<span class="open-hint">Open</span>{/if}
    </button>
  </div>
  {#if open}
    <div class="body">
      <pre>{inputJson}</pre>
      {#if tool.output}
        <pre class="output">{tool.output}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool {
    font-size: 14px;
    border-left: 3px solid var(--line);
  }
  .tool + :global(.tool) {
    border-top: 1px solid var(--line);
  }
  .tool[data-status='running'] {
    border-left-color: var(--running);
  }
  .tool[data-status='done'] {
    border-left-color: color-mix(in srgb, var(--done) 55%, var(--raised));
  }
  .tool[data-status='error'] {
    border-left-color: var(--error);
  }
  .tool.linked {
    background: color-mix(in srgb, var(--text) 4%, transparent);
  }

  .head {
    display: flex;
    align-items: stretch;
  }
  button {
    background: none;
    border: none;
  }
  .chev {
    padding: 0 4px 0 10px;
    color: var(--muted);
  }
  .chev span {
    display: inline-block;
    transition: transform 0.12s;
  }
  .chev.open span {
    transform: rotate(90deg);
  }
  .main {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    padding: 6px 12px 6px 4px;
    text-align: left;
  }
  .name {
    font-weight: 600;
  }
  .tag {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    padding: 0 5px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  .linked .tag {
    border-color: var(--muted);
    color: var(--text);
  }
  .summary {
    flex: 1;
    min-width: 0;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .state {
    color: var(--error);
    font-size: 13px;
  }
  .open-hint {
    font-size: 13px;
    color: var(--accent);
  }
  .main:hover .open-hint {
    text-decoration: underline;
  }

  .body {
    border-top: 1px dashed var(--line);
    padding: 8px 12px 10px 32px;
  }
  pre {
    margin: 0;
    max-height: 320px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12.5px;
    color: var(--muted);
  }
  pre.output {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px dashed var(--line);
    color: var(--text);
  }
</style>
