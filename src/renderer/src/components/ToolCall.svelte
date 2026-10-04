<script lang="ts">
  import type { Block, Subagent } from '@shared/session'
  import { summarizeInput } from '@shared/session'
  import { foldContext, toolView } from '@shared/tools'
  import { highlightFile } from '../lib/markdown'
  import { deck, view } from '../lib/session.svelte'
  import StatusGlyph from './StatusGlyph.svelte'

  let { tool, subagent }: { tool: Extract<Block, { type: 'tool' }>; subagent?: Subagent } = $props()
  let open = $state(false)
  /** Generic tools: the raw input is only shown on request. */
  let showRaw = $state(false)

  const shown = $derived(toolView(tool.name, tool.input))
  const path = $derived('path' in shown ? shown.path : '')
  const summary = $derived(path ? shortPath(path) : shown.kind === 'bash' ? shown.command : summarizeInput(tool.input))
  const inputJson = $derived(JSON.stringify(tool.input, null, 2))
  const tag = $derived(subagent ? deck.tags[subagent.id] : '')
  /** Write bodies are highlighted only while open: files can be long. */
  const writeHtml = $derived(open && shown.kind === 'write' ? highlightFile(shown.path, shown.content) : '')

  /** The last few path segments; the full path stays in the tooltip. */
  function shortPath(p: string) {
    const parts = p.split(/[\\/]/).filter(Boolean)
    return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : parts.join('/')
  }
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
      <span class="summary" title={path || undefined}>{summary}</span>
      {#if shown.kind === 'edit'}
        <span class="stat"><span class="add">+{shown.added}</span> <span class="del">−{shown.removed}</span></span>
      {:else if shown.kind === 'write'}
        <span class="stat">{shown.lines} {shown.lines === 1 ? 'line' : 'lines'}</span>
      {:else if shown.kind === 'read' && shown.range}
        <span class="stat">{shown.range}</span>
      {/if}
      {#if tool.status === 'error'}<span class="state">failed</span>{/if}
      {#if subagent}<span class="open-hint">Open</span>{/if}
    </button>
  </div>
  {#if open}
    <div class="body">
      {#if shown.kind === 'edit'}
        {#each shown.hunks as hunk, h (h)}
          <div class="diff" role="group" aria-label="Change {h + 1} of {shown.hunks.length}">
            {#each foldContext(hunk) as line, i (i)}
              {#if line.op === 'skip'}
                <div class="skip">⋯ {line.count} unchanged {line.count === 1 ? 'line' : 'lines'}</div>
              {:else}
                <div class="dl" data-op={line.op}><span class="op" aria-hidden="true">{line.op}</span>{line.text}</div>
              {/if}
            {/each}
          </div>
        {/each}
        {#if tool.status === 'error' && tool.output}<pre class="output">{tool.output}</pre>{/if}
      {:else if shown.kind === 'write'}
        <pre class="code hljs"><code>{@html writeHtml}</code></pre>
        {#if tool.status === 'error' && tool.output}<pre class="output">{tool.output}</pre>{/if}
      {:else if shown.kind === 'bash'}
        <div class="term">
          <pre class="cmd"><span class="prompt" aria-hidden="true">$ </span>{shown.command}</pre>
          {#if tool.output}
            <pre class="out" class:err={tool.status === 'error'}>{tool.output}</pre>
          {:else if tool.status === 'running'}
            <pre class="out">Running…</pre>
          {/if}
        </div>
        {#if shown.description}<p class="desc">{shown.description}</p>{/if}
      {:else if shown.kind === 'read'}
        <p class="desc" title={shown.path}>{shown.path}{shown.range ? `, ${shown.range}` : ''}</p>
        {#if tool.output}<pre class="output">{tool.output}</pre>{/if}
      {:else}
        {#if tool.output}<pre class="output first">{tool.output}</pre>{/if}
        {#if !tool.output || showRaw}<pre>{inputJson}</pre>{/if}
        {#if tool.output && !showRaw}
          <button class="raw" onclick={() => (showRaw = true)}>Show input</button>
        {/if}
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
  .stat {
    flex-shrink: 0;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 12px;
  }
  .add {
    color: var(--done);
  }
  .del {
    color: var(--error);
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
  pre.output.first {
    margin-top: 0;
    padding-top: 0;
    border-top: none;
  }

  .diff {
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.5;
    max-height: 420px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--sunken);
  }
  .diff + .diff {
    margin-top: 8px;
  }
  .dl {
    white-space: pre-wrap;
    word-break: break-word;
    padding: 0 10px 0 0;
  }
  .op {
    display: inline-block;
    width: 22px;
    text-align: center;
    color: var(--muted);
    user-select: none;
  }
  .dl[data-op='+'] {
    background: color-mix(in srgb, var(--done) 13%, transparent);
  }
  .dl[data-op='+'] .op {
    color: var(--done);
  }
  .dl[data-op='-'] {
    background: color-mix(in srgb, var(--error) 13%, transparent);
  }
  .dl[data-op='-'] .op {
    color: var(--error);
  }
  .skip {
    padding: 1px 10px 1px 22px;
    color: var(--muted);
    font-size: 11.5px;
    background: color-mix(in srgb, var(--text) 3%, transparent);
  }

  pre.code,
  .term {
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--sunken) !important;
    color: var(--text);
    max-height: 420px;
    overflow: auto;
  }
  .term pre {
    max-height: none;
    overflow: visible;
  }
  .cmd {
    color: var(--text);
  }
  .prompt {
    color: var(--accent);
  }
  pre.out {
    margin-top: 4px;
    color: var(--muted);
  }
  pre.out.err {
    color: var(--error);
  }
  .desc {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 12.5px;
    font-family: var(--mono);
    word-break: break-all;
  }
  .raw {
    margin-top: 6px;
    padding: 0;
    color: var(--accent);
    font-size: 12.5px;
  }
</style>
