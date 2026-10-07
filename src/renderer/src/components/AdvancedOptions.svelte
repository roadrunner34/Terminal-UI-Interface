<script lang="ts">
  import type { AgentId, ClaudeSessionOptions, PiSessionOptions } from '@shared/events'
  import ContextFiles from './ContextFiles.svelte'

  /** The form's options for `agent`; edited in place. */
  let {
    agent,
    options = $bindable(),
    cwd
  }: { agent: AgentId; options: ClaudeSessionOptions & PiSessionOptions; cwd: string } = $props()

  async function addDir() {
    const dir = await window.agentDeck.pickDirectory()
    if (dir && !options.addDirs?.includes(dir)) options.addDirs = [...(options.addDirs ?? []), dir]
  }
  async function addMcpConfig() {
    const file = await window.agentDeck.pickFile('json')
    if (file && !options.mcpConfigs?.includes(file)) options.mcpConfigs = [...(options.mcpConfigs ?? []), file]
  }
  async function pickAgents() {
    const file = await window.agentDeck.pickFile('json')
    if (file) options.agentsFile = file
  }
  function remove(key: 'addDirs' | 'mcpConfigs' | 'extensions', item: string) {
    options[key] = options[key]?.filter((x) => x !== item)
    if (key === 'mcpConfigs' && !options.mcpConfigs?.length) options.strictMcp = undefined
  }

  let extension = $state('')
  // Same rule as main: npm or git sources; a value starting with "-" would be read as a flag.
  const extensionOk = $derived(/^(npm:|git:|https:\/\/)\S+$/.test(extension.trim()))
  function addExtension() {
    const e = extension.trim()
    if (!extensionOk || options.extensions?.includes(e)) return
    options.extensions = [...(options.extensions ?? []), e]
    extension = ''
  }
</script>

<div class="adv">
  <label class="wide">
    <span class="lbl">Add to the system prompt</span>
    <textarea
      rows="3"
      placeholder="Instructions for this session only"
      value={options.appendSystemPrompt ?? ''}
      oninput={(e) => (options.appendSystemPrompt = e.currentTarget.value || undefined)}
    ></textarea>
  </label>

  {#if agent === 'claude'}
    <div class="wide">
      <span class="lbl">Extra folders Claude may use</span>
      {#each options.addDirs ?? [] as d (d)}
        <div class="item"><span class="path" title={d}>{d}</span><button class="x" aria-label="Remove {d}" onclick={() => remove('addDirs', d)}>×</button></div>
      {/each}
      <button class="add" onclick={addDir}>Add folder…</button>
    </div>

    <div class="wide">
      <span class="lbl">MCP config files</span>
      {#each options.mcpConfigs ?? [] as f (f)}
        <div class="item"><span class="path" title={f}>{f}</span><button class="x" aria-label="Remove {f}" onclick={() => remove('mcpConfigs', f)}>×</button></div>
      {/each}
      <button class="add" onclick={addMcpConfig}>Add file…</button>
      <label class="check" class:off={!options.mcpConfigs?.length}>
        <input
          type="checkbox"
          disabled={!options.mcpConfigs?.length}
          checked={!!options.strictMcp}
          onchange={(e) => (options.strictMcp = e.currentTarget.checked || undefined)}
        />
        Only these MCP servers
      </label>
    </div>

    <div class="wide">
      <span class="lbl">Subagents file</span>
      {#if options.agentsFile}
        <div class="item">
          <span class="path" title={options.agentsFile}>{options.agentsFile}</span><button
            class="x"
            aria-label="Clear the subagents file"
            onclick={() => (options.agentsFile = undefined)}>×</button
          >
        </div>
      {:else}
        <button class="add" onclick={pickAgents}>Choose file…</button>
      {/if}
    </div>

    <div class="row">
      <label>
        <span class="lbl">Budget cap, USD</span>
        <input
          type="number"
          min="0"
          step="0.5"
          placeholder="None"
          value={options.maxBudgetUsd ?? ''}
          oninput={(e) => {
            const v = e.currentTarget.valueAsNumber
            options.maxBudgetUsd = v > 0 ? v : undefined
          }}
        />
      </label>
      <label>
        <span class="lbl">Fallback models</span>
        <input
          spellcheck="false"
          placeholder="sonnet,haiku"
          value={options.fallbackModel ?? ''}
          oninput={(e) => (options.fallbackModel = e.currentTarget.value || undefined)}
        />
      </label>
    </div>

    <div class="row">
      <label>
        <span class="lbl">Allowed tools</span>
        <input
          spellcheck="false"
          placeholder="Bash(git *) Edit"
          value={options.allowedTools ?? ''}
          oninput={(e) => (options.allowedTools = e.currentTarget.value || undefined)}
        />
      </label>
      <label>
        <span class="lbl">Disallowed tools</span>
        <input
          spellcheck="false"
          placeholder="WebFetch"
          value={options.disallowedTools ?? ''}
          oninput={(e) => (options.disallowedTools = e.currentTarget.value || undefined)}
        />
      </label>
    </div>

    <label class="check">
      <input type="checkbox" checked={!!options.bare} onchange={(e) => (options.bare = e.currentTarget.checked || undefined)} />
      Bare mode
    </label>
    <p class="hint" class:warn={options.bare}>
      Skips hooks, plugins, CLAUDE.md, memory and your Claude login. It only works with an <code>ANTHROPIC_API_KEY</code>; with a
      subscription, sign-in fails.
    </p>
  {:else}
    <div class="wide">
      <span class="lbl">Extra extensions, this session only</span>
      {#each options.extensions ?? [] as x (x)}
        <div class="item"><span class="path" title={x}>{x}</span><button class="x" aria-label="Remove {x}" onclick={() => remove('extensions', x)}>×</button></div>
      {/each}
      <div class="inline">
        <input
          spellcheck="false"
          placeholder="npm:pi-foo or git:github.com/user/repo"
          bind:value={extension}
          onkeydown={(e) => e.key === 'Enter' && addExtension()}
        />
        <button class="add" disabled={!extensionOk} onclick={addExtension}>Add</button>
      </div>
    </div>

    <div class="row">
      <label>
        <span class="lbl">Tools</span>
        <input
          spellcheck="false"
          placeholder="read,bash,edit,write"
          value={options.tools ?? ''}
          oninput={(e) => (options.tools = e.currentTarget.value || undefined)}
        />
      </label>
      <label>
        <span class="lbl">Exclude tools</span>
        <input
          spellcheck="false"
          placeholder="mcp__server__*"
          value={options.excludeTools ?? ''}
          oninput={(e) => (options.excludeTools = e.currentTarget.value || undefined)}
        />
      </label>
    </div>
    <p class="hint">
      Tools replaces the default set (read, bash, edit, write); MCP tools stay unless an entry starts with <code>mcp__</code>.
      <code>*</code> matches anything. Plan mode keeps its own read-only tools.
    </p>

    <div class="checks">
      <label class="check">
        <input type="checkbox" checked={!!options.noMcp} onchange={(e) => (options.noMcp = e.currentTarget.checked || undefined)} />
        No MCP servers
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={!!options.noContextFiles}
          onchange={(e) => (options.noContextFiles = e.currentTarget.checked || undefined)}
        />
        Skip AGENTS.md files
      </label>
    </div>

    {#if cwd}
      <ContextFiles {cwd} />
    {/if}
  {/if}
</div>

<style>
  .adv {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-top: 10px;
    font-size: 13px;
  }
  .lbl {
    display: block;
    margin-bottom: 4px;
    color: var(--muted);
  }
  label,
  .wide {
    display: block;
    min-width: 0;
  }
  .row {
    display: flex;
    gap: 10px;
  }
  .row > label {
    flex: 1;
  }
  input:not([type='checkbox']),
  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--sunken);
    color: var(--text);
    font: inherit;
  }
  input[spellcheck='false'] {
    font-family: var(--mono);
    font-size: 12.5px;
  }
  textarea {
    resize: vertical;
    min-height: 56px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    padding: 3px 4px 3px 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 12.5px;
  }
  .x {
    padding: 0 6px;
    border: none;
    background: none;
    color: var(--muted);
    font-size: 15px;
    line-height: 1;
  }
  .x:hover {
    color: var(--text);
  }
  .add {
    padding: 3px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font-size: 12.5px;
  }
  .add:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .inline {
    display: flex;
    gap: 6px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }
  .check.off {
    opacity: 0.5;
  }
  .checks {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
  }
  .checks .check {
    margin-top: 0;
  }
  .hint {
    margin: -6px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
  .hint.warn {
    color: var(--warn);
  }
</style>
