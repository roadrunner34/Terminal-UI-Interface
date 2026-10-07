<script lang="ts">
  import type { PiOutput, PiPackage, PiPackageOp, PiPackageSearchResult } from '@shared/api'
  import { activeTab, tabs } from '../lib/session.svelte'

  let dialog: HTMLDialogElement

  /** The project the "this project only" scope means: the running session's folder, or the setup form's. */
  let cwd = $state('')
  let packages = $state<PiPackage[]>([])
  let listError = $state('')

  let source = $state('')
  let local = $state(false)
  /** An operation waiting for the user to confirm it. */
  let confirming = $state<PiPackageOp | null>(null)
  /** The command running now, its output, and how the last one ended. */
  let runId = $state<string | null>(null)
  let log = $state<string[]>([])
  let logOpen = $state(false)
  let result = $state<{ ok: boolean; text: string } | null>(null)
  let changed = $state(false)
  let reloadNote = $state('')

  let query = $state('')
  let results = $state<PiPackageSearchResult[] | null>(null)
  let searching = $state(false)
  let searchError = $state('')

  const SOURCE = /^(npm:(@[\w.-]+\/)?[\w.-]+(@[\w.^~-]+)?|git:[\w.@:/-]+|https:\/\/[\w./-]+)$/
  const sourceOk = $derived(SOURCE.test(source.trim()))
  const sourceHint = $derived(
    !source.trim() || sourceOk
      ? ''
      : /^[a-z]:|^[\\/.]|\s/i.test(source.trim())
        ? 'Local paths aren’t supported here; use an npm or git source.'
        : 'Use npm:name or git:host/user/repo.'
  )
  const piTabs = $derived(tabs.list.filter((t) => t.state.running && t.state.agent === 'pi').length)
  const groups = $derived([
    { scope: 'user' as const, title: 'Yours', note: 'In every project.', items: packages.filter((p) => p.scope === 'user') },
    {
      scope: 'project' as const,
      title: 'This project',
      note: 'Load once you trust the project in Pi.',
      items: packages.filter((p) => p.scope === 'project')
    }
  ])

  /** Output that arrived before runPiPackage's reply named its run. */
  let early: PiOutput[] = []

  function onOutput(o: PiOutput) {
    if ('line' in o) log.push(o.line)
    else finish(o.exit)
  }

  $effect(() => {
    // Output from main, for the command this dialog started.
    return window.agentDeck.onPiOutput((o: PiOutput) => {
      if (o.id === runId) onOutput(o)
      else if (waiting) early.push(o)
    })
  })

  /** Between asking main to run and hearing the run's id. */
  let waiting = false

  export async function open() {
    // The running session's folder, or the one chosen in the setup form.
    cwd = activeTab().form.cwd
    result = null
    reloadNote = ''
    dialog.showModal()
    await refresh()
  }

  async function refresh() {
    listError = ''
    try {
      packages = await window.agentDeck.listPiPackages(cwd || undefined)
    } catch (err) {
      listError = err instanceof Error ? err.message : String(err)
    }
  }

  function describe(op: PiPackageOp): string {
    const what = op.source ?? 'all packages'
    const where = op.local ? 'this project only' : 'every project'
    return { install: `Install ${what} for ${where}?`, remove: `Remove ${what}?`, update: `Update ${what}?`, 'update-all': 'Update all packages?' }[op.op]
  }

  async function go(op: PiPackageOp) {
    confirming = null
    result = null
    reloadNote = ''
    log = []
    logOpen = true
    early = []
    waiting = true
    const res = await window.agentDeck.runPiPackage(op, cwd || undefined)
    waiting = false
    if ('error' in res) {
      result = { ok: false, text: res.error }
      return
    }
    runId = res.id
    const mine = early.filter((o) => o.id === res.id)
    early = []
    for (const o of mine) onOutput(o)
  }

  async function finish(code: number | null) {
    runId = null
    const ok = code === 0
    result = { ok, text: ok ? 'Done.' : `Failed${code === null ? '' : ` (exit ${code})`}. See the output above.` }
    if (ok) {
      changed = true
      source = ''
      logOpen = false
    }
    await refresh()
  }

  async function reload() {
    const r = await window.agentDeck.reloadPiTabs()
    changed = false
    reloadNote =
      r.reloaded || r.later
        ? `Reloaded ${r.reloaded} Pi tab${r.reloaded === 1 ? '' : 's'}${r.later ? `; ${r.later} will reload when its turn finishes` : ''}.`
        : 'No Pi tabs are running. New sessions load the changes.'
  }

  async function search(e?: SubmitEvent) {
    e?.preventDefault()
    searching = true
    searchError = ''
    try {
      results = await window.agentDeck.searchPiPackages(query)
    } catch (err) {
      searchError = err instanceof Error ? err.message : String(err)
    } finally {
      searching = false
    }
  }

  function counts(p: PiPackage): string {
    const r = p.resources ?? {}
    const n = (k: number | undefined, one: string) => (k ? `${k} ${one}${k === 1 ? '' : 's'}` : '')
    return [n(r.extensions, 'extension'), n(r.skills, 'skill'), n(r.prompts, 'prompt'), n(r.themes, 'theme')].filter(Boolean).join(' · ')
  }

  const downloads = (n?: number) => (n === undefined ? '' : n >= 1000 ? `${Math.round(n / 1000)}k/week` : `${n}/week`)
</script>

<dialog bind:this={dialog} aria-labelledby="pkg-title">
  <div class="body">
    <header>
      <h2 id="pkg-title">Pi packages</h2>
      <button class="close" aria-label="Close" onclick={() => dialog.close()}>×</button>
    </header>

    <section>
      <div class="head">
        <h3>Installed</h3>
        <button class="small" disabled={!!runId || !packages.length} onclick={() => (confirming = { op: 'update-all' })}>Update all</button>
      </div>
      {#if listError}<p class="err">{listError}</p>{/if}
      {#each groups as g (g.scope)}
        {#if g.scope === 'user' || cwd}
          <h4>{g.title} <span class="sub">{g.note}</span></h4>
          {#if g.items.length}
            <ul class="pkgs">
              {#each g.items as p (p.scope + p.source)}
                <li>
                  <div class="pmain">
                    <span class="pname" title={p.source}>{p.name ?? p.source}</span>
                    {#if p.version}<span class="ver">{p.version}</span>{/if}
                    {#if p.filtered}<span class="tag" title="Its settings entry loads only some of its resources">filtered</span>{/if}
                    {#if p.kind === 'npm' && !p.installed}<span class="tag warn">not installed</span>{/if}
                  </div>
                  {#if p.description}<p class="desc">{p.description}</p>{/if}
                  <p class="meta">{[p.name && p.source !== `npm:${p.name}` ? p.source : '', counts(p)].filter(Boolean).join(' · ')}</p>
                  <div class="acts">
                    {#if p.kind !== 'local'}
                      <button class="small" disabled={!!runId} onclick={() => (confirming = { op: 'update', source: p.source, local: p.scope === 'project' })}
                        >Update</button
                      >
                    {/if}
                    <button class="small" disabled={!!runId} onclick={() => (confirming = { op: 'remove', source: p.source, local: p.scope === 'project' })}
                      >Remove</button
                    >
                  </div>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="empty">None.</p>
          {/if}
        {/if}
      {/each}
    </section>

    <section>
      <h3>Install</h3>
      <form
        class="install"
        onsubmit={(e) => {
          e.preventDefault()
          if (sourceOk && !runId) confirming = { op: 'install', source: source.trim(), local }
        }}
      >
        <input bind:value={source} spellcheck="false" placeholder="npm:pi-foo or git:github.com/user/repo" aria-label="Package source" />
        <button class="primary" type="submit" disabled={!sourceOk || !!runId}>{runId ? 'Working…' : 'Install'}</button>
      </form>
      {#if sourceHint}<p class="hint warn">{sourceHint}</p>{/if}
      <label class="check" class:off={!cwd} title={cwd ? cwd : 'Choose a project folder first'}>
        <input type="checkbox" bind:checked={local} disabled={!cwd} />
        This project only{#if cwd}<span class="sub"> ({cwd.split(/[\\/]/).filter(Boolean).pop()})</span>{/if}
      </label>
    </section>

    {#if confirming}
      <div class="confirm" role="alertdialog" aria-labelledby="pkg-confirm">
        <p id="pkg-confirm"><strong>{describe(confirming)}</strong></p>
        {#if confirming.op === 'install' || confirming.op === 'update' || confirming.op === 'update-all'}
          <p class="warn">Pi packages run code on your machine with your permissions. Install only sources you trust.</p>
        {/if}
        {#if confirming.local && confirming.op !== 'install'}
          <p class="sub">Pi changes a project's packages only for trusted projects, so this trusts the project for this one command.</p>
        {/if}
        <div class="acts">
          <button class="small" onclick={() => (confirming = null)}>Cancel</button>
          <button class="small primary" onclick={() => confirming && go(confirming)}>{confirming.op === 'remove' ? 'Remove' : 'Continue'}</button>
        </div>
      </div>
    {/if}

    {#if log.length}
      <details class="log" bind:open={logOpen}>
        <summary>Output{runId ? ' (running)' : ''}</summary>
        <pre>{log.join('\n')}</pre>
      </details>
    {/if}
    {#if result}
      <p class="result" class:bad={!result.ok} role="status">{result.text}</p>
    {/if}
    {#if changed && piTabs}
      <p class="reload">
        Running Pi tabs still use the old packages.
        <button class="small primary" onclick={reload}>Reload Pi tabs</button>
      </p>
    {:else if changed}
      <p class="sub">New Pi sessions load the change.</p>
    {/if}
    {#if reloadNote}<p class="sub">{reloadNote}</p>{/if}

    <section>
      <div class="head">
        <h3>Discover</h3>
        <a href="https://pi.dev/packages" target="_blank" rel="noreferrer">pi.dev/packages</a>
      </div>
      <form class="install" onsubmit={search}>
        <input bind:value={query} placeholder="Search npm packages tagged pi-package" aria-label="Search packages" />
        <button class="small" type="submit" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
      </form>
      {#if searchError}<p class="err">{searchError}</p>{/if}
      {#if results}
        {#if results.length}
          <ul class="pkgs">
            {#each results as r (r.name)}
              <li>
                <div class="pmain">
                  <span class="pname">{r.name}</span>
                  <span class="ver">{r.version}</span>
                  <span class="dl">{downloads(r.weeklyDownloads)}</span>
                </div>
                {#if r.description}<p class="desc">{r.description}</p>{/if}
                <div class="acts">
                  <button class="small" title="Puts it in the Install box; nothing is installed yet" onclick={() => (source = `npm:${r.name}`)}
                    >Use</button
                  >
                </div>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty">No packages found.</p>
        {/if}
      {/if}
    </section>
  </div>
</dialog>

<style>
  dialog {
    width: min(640px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--raised);
    color: var(--text);
    box-shadow: 0 20px 60px rgb(0 0 0 / 0.45);
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.5);
  }
  .body {
    max-height: calc(100vh - 66px);
    overflow-y: auto;
    padding: 18px 22px 20px;
    box-sizing: border-box;
  }
  header,
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  h4 {
    margin: 10px 0 4px;
    font-size: 13px;
    font-weight: 600;
  }
  section {
    margin-top: 18px;
  }
  .close {
    border: none;
    background: none;
    color: var(--muted);
    font-size: 20px;
    line-height: 1;
    padding: 2px 6px;
  }
  .close:hover {
    color: var(--text);
  }
  .sub {
    font-weight: normal;
    color: var(--muted);
    font-size: 12.5px;
  }
  .pkgs {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pkgs li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 10px;
    padding: 8px 0;
    border-top: 1px solid var(--line);
  }
  .pmain {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .pname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 13px;
  }
  .ver,
  .dl {
    flex-shrink: 0;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .tag {
    flex-shrink: 0;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: 9px;
    font-size: 11px;
    color: var(--muted);
  }
  .tag.warn {
    color: var(--warn);
  }
  .desc,
  .meta {
    grid-column: 1;
    margin: 2px 0 0;
    font-size: 12.5px;
    color: var(--muted);
  }
  .meta:empty {
    display: none;
  }
  .acts {
    grid-column: 2;
    grid-row: 1 / span 3;
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }
  .small {
    padding: 3px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font-size: 12.5px;
    white-space: nowrap;
  }
  .small:hover:not(:disabled) {
    border-color: var(--muted);
  }
  .primary {
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    color: var(--ink);
    font-weight: 600;
    padding: 6px 16px;
  }
  .small.primary {
    padding: 3px 10px;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .install {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
  .install input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--sunken);
    color: var(--text);
    font-family: var(--mono);
    font-size: 13px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    font-size: 13px;
  }
  .check.off {
    opacity: 0.5;
  }
  .hint {
    margin: 4px 0 0;
    font-size: 12.5px;
  }
  .warn {
    color: var(--warn);
  }
  .err,
  .bad {
    color: var(--error);
  }
  .empty {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 12.5px;
  }
  .confirm {
    margin-top: 14px;
    padding: 10px 12px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    font-size: 13px;
  }
  .confirm p {
    margin: 0 0 6px;
    overflow-wrap: anywhere;
  }
  .confirm .acts {
    justify-content: flex-end;
  }
  .log {
    margin-top: 12px;
    font-size: 12.5px;
  }
  .log summary {
    cursor: pointer;
    color: var(--muted);
  }
  .log pre {
    max-height: 200px;
    overflow: auto;
    margin: 6px 0 0;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--sunken);
    font-family: var(--mono);
    font-size: 12px;
    white-space: pre-wrap;
  }
  .result,
  .reload {
    margin: 8px 0 0;
    font-size: 13px;
  }
  .reload {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  a {
    color: var(--accent);
    font-size: 12.5px;
  }
</style>
