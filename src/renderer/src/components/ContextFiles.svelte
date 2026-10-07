<script lang="ts">
  import type { ContextFileInfo, PiContextFile } from '@shared/api'

  /** Pi's instruction files for this folder, edited in place. Changes apply from the next session. */
  let { cwd }: { cwd: string } = $props()

  const tabs: { id: PiContextFile; label: string; note: string }[] = [
    { id: 'project-agents', label: 'Project AGENTS.md', note: 'Read from this folder and its parents in every session.' },
    {
      id: 'project-append',
      label: 'Project APPEND_SYSTEM.md',
      note: "Added to Pi's system prompt. Files in .pi/ only apply once you trust this project in Pi."
    },
    { id: 'global-agents', label: 'Global AGENTS.md', note: "In Pi's agent folder; applies to every project." }
  ]

  let which = $state<PiContextFile>('project-agents')
  let file = $state<ContextFileInfo | null>(null)
  let text = $state('')
  let status = $state('')
  let systemFiles = $state<ContextFileInfo[]>([])

  const dirty = $derived(!!file && text !== file.text)
  const note = $derived(tabs.find((t) => t.id === which)?.note ?? '')

  async function load(w: PiContextFile, dir: string) {
    status = ''
    try {
      const f = await window.agentDeck.readContext(dir, w)
      // A newer pick (tab or folder) may have landed meanwhile.
      if (w !== which || dir !== cwd) return
      file = f
      text = f.text
    } catch (err) {
      file = null
      status = err instanceof Error ? err.message : String(err)
    }
  }

  $effect(() => {
    void load(which, cwd)
  })

  // SYSTEM.md replaces the whole prompt; only say that one is there.
  $effect(() => {
    const dir = cwd
    Promise.all([window.agentDeck.readContext(dir, 'project-system'), window.agentDeck.readContext(dir, 'global-system')])
      .then((all) => {
        if (dir === cwd) systemFiles = all.filter((f) => f.exists)
      })
      .catch(() => (systemFiles = []))
  })

  function choose(id: PiContextFile) {
    if (id !== which && !dirty) which = id
  }

  async function save() {
    try {
      file = await window.agentDeck.writeContext(cwd, which, text)
      status = 'Saved. It applies from the next session.'
    } catch (err) {
      status = err instanceof Error ? err.message : String(err)
    }
  }
</script>

<section class="ctx">
  <h4>Instructions</h4>
  <div class="tabs" role="tablist">
    {#each tabs as t (t.id)}
      <button
        role="tab"
        aria-selected={which === t.id}
        class:on={which === t.id}
        disabled={dirty && which !== t.id}
        title={dirty && which !== t.id ? 'Save or discard your changes first' : ''}
        onclick={() => choose(t.id)}>{t.label}</button
      >
    {/each}
  </div>
  <p class="note">{note}</p>
  {#if file}
    <p class="path" title={file.path}>{file.path}{file.exists ? '' : ' (new file)'}</p>
  {/if}
  <textarea rows="7" spellcheck="false" bind:value={text} aria-label={tabs.find((t) => t.id === which)?.label}></textarea>
  <div class="foot">
    <span class="status" role="status">{status}</span>
    {#if dirty}<button class="save" onclick={() => (text = file?.text ?? '')}>Discard</button>{/if}
    <button class="save" disabled={!dirty} onclick={save}>Save</button>
  </div>
  {#each systemFiles as s (s.path)}
    <details class="system">
      <summary>{s.which === 'project-system' ? 'This project' : 'Pi'} has a SYSTEM.md, which replaces Pi's whole prompt</summary>
      <p class="path" title={s.path}>{s.path}</p>
      <pre>{s.text}</pre>
    </details>
  {/each}
</section>

<style>
  .ctx {
    border-top: 1px solid var(--line);
    padding-top: 10px;
  }
  h4 {
    margin: 0 0 6px;
    font-size: 13px;
    font-weight: 600;
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .tabs button {
    padding: 3px 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    font-size: 12px;
  }
  .tabs button.on {
    color: var(--text);
    border-color: var(--muted);
    background: var(--raised);
  }
  .tabs button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .note {
    margin: 6px 0 2px;
    font-size: 12px;
    color: var(--muted);
  }
  .path {
    margin: 0 0 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--muted);
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--sunken);
    color: var(--text);
    font-family: var(--mono);
    font-size: 12.5px;
    resize: vertical;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  .status {
    flex: 1;
    font-size: 12px;
    color: var(--muted);
  }
  .save {
    padding: 3px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font-size: 12.5px;
  }
  .save:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .system {
    margin-top: 8px;
    font-size: 12px;
    color: var(--warn);
  }
  .system pre {
    max-height: 140px;
    overflow: auto;
    margin: 0;
    padding: 6px 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 12px;
    white-space: pre-wrap;
  }
</style>
