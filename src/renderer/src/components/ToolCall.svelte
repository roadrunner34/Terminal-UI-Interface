<script lang="ts">
  import type { Block, Subagent } from '@shared/session'
  import { summarizeInput } from '@shared/session'
  import { view } from '../lib/session.svelte'

  let { tool, subagent }: { tool: Extract<Block, { type: 'tool' }>; subagent?: Subagent } = $props()
  let open = $state(false)

  const summary = $derived(summarizeInput(tool.input))
  const inputJson = $derived(JSON.stringify(tool.input, null, 2))
</script>

<div class="tool" data-status={tool.status}>
  <div class="head">
    <button class="toggle" onclick={() => (open = !open)} aria-expanded={open}>
      <span class="chev" class:open aria-hidden="true">›</span>
      <span class="name">{tool.name}</span>
      <span class="summary">{summary}</span>
      <span class="state">{tool.status === 'running' ? 'running' : tool.status === 'error' ? 'failed' : ''}</span>
    </button>
    {#if subagent}
      <button class="follow" onclick={() => (view.scope = subagent.id)}>View subagent</button>
    {/if}
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
    border: 1px solid var(--line);
    border-left: 3px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--raised);
    font-size: 14px;
  }
  .tool[data-status='running'] {
    border-left-color: var(--running);
  }
  .tool[data-status='done'] {
    border-left-color: var(--done);
  }
  .tool[data-status='error'] {
    border-left-color: var(--error);
  }

  .head {
    display: flex;
    align-items: center;
  }
  .toggle {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    padding: 6px 12px;
    background: none;
    border: none;
    text-align: left;
  }
  .chev {
    color: var(--muted);
    transition: transform 0.12s;
    display: inline-block;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .name {
    font-weight: 600;
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
    color: var(--muted);
    font-size: 13px;
  }
  [data-status='error'] .state {
    color: var(--error);
  }

  .follow {
    margin-right: 8px;
    background: none;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 2px 10px;
    font-size: 13px;
    color: var(--running);
    white-space: nowrap;
  }

  .body {
    border-top: 1px solid var(--line);
    padding: 8px 12px 10px;
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
