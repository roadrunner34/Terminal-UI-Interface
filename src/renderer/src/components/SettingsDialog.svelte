<script lang="ts">
  import type { AgentId } from '@shared/events'
  import type { AppSettings, CliVersion } from '@shared/api'
  import { session } from '../lib/session.svelte'
  import PackagesDialog from './PackagesDialog.svelte'

  /** Called with the saved settings, so the top bar keeps its copy current. */
  let { onsaved }: { onsaved?: (s: AppSettings) => void } = $props()

  let dialog: HTMLDialogElement
  let packagesDialog: PackagesDialog
  let draft = $state<AppSettings | null>(null)
  /** piSubagentTools, edited as one comma-separated field. */
  let tools = $state('')
  let saving = $state(false)

  /** Each CLI's version, from the saved commands; checked each time the dialog opens. */
  let versions = $state<Partial<Record<AgentId, CliVersion>>>({})
  let checking = $state(false)

  async function checkVersions() {
    checking = true
    try {
      versions = Object.fromEntries((await window.agentDeck.cliVersions(true)).map((v) => [v.agent, v]))
    } catch {
      versions = {}
    } finally {
      checking = false
    }
  }

  function versionLine(agent: AgentId, command: string): string {
    const v = versions[agent]
    if (!v) return checking ? 'Checking the version…' : ''
    // The check ran the saved command, not this edit of it.
    if ((command.trim() || (agent === 'claude' ? 'claude' : 'pi')) !== v.command) return 'Save, then reopen Settings to check this command.'
    return v.status === 'ok' ? `Version ${v.version}.` : (v.message ?? '')
  }

  export async function open() {
    draft = await window.agentDeck.getSettings()
    tools = draft.piSubagentTools.join(', ')
    versions = {}
    void checkVersions()
    dialog.showModal()
  }

  const permissionModes = [
    { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits run on their own; other commands ask you.' },
    { value: 'default', label: 'Ask for everything', hint: 'Every edit and command that isn’t pre-allowed asks you.' },
    { value: 'auto', label: 'Auto', hint: 'Claude’s classifier approves commands it judges safe; the rest ask you.' },
    { value: 'bypassPermissions', label: 'Bypass permissions', hint: 'Nothing asks. Only for sandboxes you can throw away.' }
  ]
  const modeHint = $derived(permissionModes.find((m) => m.value === draft?.permissionMode)?.hint ?? '')

  async function save(e: SubmitEvent) {
    e.preventDefault()
    if (!draft) return
    saving = true
    try {
      const saved = await window.agentDeck.saveSettings({
        claudePath: draft.claudePath.trim() || 'claude',
        piPath: draft.piPath.trim() || 'pi',
        permissionMode: draft.permissionMode,
        approvals: draft.approvals,
        notifications: draft.notifications,
        piAutoCompaction: draft.piAutoCompaction,
        piSubagentTools: tools
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      })
      onsaved?.(saved)
      dialog.close()
    } finally {
      saving = false
    }
  }
</script>

<dialog bind:this={dialog} aria-labelledby="settings-title" onclose={() => (draft = null)}>
  {#if draft}
    <form onsubmit={save}>
      <h2 id="settings-title">Settings</h2>

      <fieldset>
        <legend>Claude Code</legend>
        <label>
          <span>Command</span>
          <input bind:value={draft.claudePath} spellcheck="false" placeholder="claude" />
        </label>
        <p class="hint version" data-status={versions.claude?.status} aria-live="polite">{versionLine('claude', draft.claudePath)}</p>
        <label>
          <span>In Auto mode</span>
          <select bind:value={draft.permissionMode}>
            {#each permissionModes as m (m.value)}
              <option value={m.value}>{m.label}</option>
            {/each}
            {#if !permissionModes.some((m) => m.value === draft?.permissionMode)}
              <option value={draft.permissionMode}>{draft.permissionMode}</option>
            {/if}
          </select>
        </label>
        <p class="hint">{modeHint} Plan mode is always read-only.</p>
      </fieldset>

      <fieldset>
        <legend>Pi</legend>
        <label>
          <span>Command</span>
          <input bind:value={draft.piPath} spellcheck="false" placeholder="pi" />
        </label>
        <p class="hint version" data-status={versions.pi?.status} aria-live="polite">{versionLine('pi', draft.piPath)}</p>
        <label>
          <span>Subagent tools</span>
          <input bind:value={tools} spellcheck="false" placeholder="subagent" />
        </label>
        <p class="hint">Tool names shown as subagent cards, separated by commas.</p>
        <label class="radio">
          <input type="checkbox" bind:checked={draft.piAutoCompaction} />
          <span
            >Compact automatically <span class="sub">Pi summarizes the conversation on its own as the context fills.</span></span
          >
        </label>
        <div class="packages">
          <button type="button" onclick={() => packagesDialog.open()}>Packages…</button>
          <span class="sub">Install, update and remove Pi extensions and skills.</span>
        </div>
      </fieldset>

      <fieldset>
        <legend>When the agent needs you</legend>
        <label class="radio">
          <input type="radio" bind:group={draft.approvals} value="ask" />
          <span>Ask me in the app <span class="sub">Approvals, questions and extension dialogs appear above the message box.</span></span>
        </label>
        <label class="radio">
          <input type="radio" bind:group={draft.approvals} value="deny" />
          <span>Refuse without asking <span class="sub">Anything that would need you is declined.</span></span>
        </label>
        <label class="radio">
          <input type="checkbox" bind:checked={draft.notifications} />
          <span
            >Desktop notifications <span class="sub"
              >When the agent finishes or needs you while this window is in the background.</span
            ></span
          >
        </label>
      </fieldset>

      <footer>
        {#if session.running}<span class="note">Changes apply from the next session.</span>{/if}
        <button type="button" onclick={() => dialog.close()}>Cancel</button>
        <button type="submit" class="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </footer>
    </form>
  {/if}
</dialog>

<PackagesDialog bind:this={packagesDialog} />

<style>
  dialog {
    width: min(520px, calc(100vw - 32px));
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
  form {
    padding: 20px 22px 18px;
  }
  h2 {
    margin: 0 0 14px;
    font-size: 18px;
    font-weight: 600;
  }
  fieldset {
    border: none;
    margin: 0 0 16px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  legend {
    padding: 0;
    margin-bottom: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  label {
    display: grid;
    grid-template-columns: 130px minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    font-size: 14px;
  }
  label.radio {
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
  }
  label.radio input {
    margin-top: 4px;
    accent-color: var(--accent);
  }
  .sub {
    display: block;
    color: var(--muted);
    font-size: 12.5px;
  }
  input:not([type]),
  select {
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--sunken);
    font-family: var(--mono);
    font-size: 13px;
  }
  select {
    font-family: var(--sans);
  }
  .hint {
    margin: 0 0 0 140px;
    color: var(--muted);
    font-size: 12.5px;
  }
  .version:empty {
    display: none;
  }
  /* Still checking. */
  .version:not([data-status]) {
    font-style: italic;
  }
  .version[data-status='old'],
  .version[data-status='new'],
  .version[data-status='unknown'],
  .version[data-status='missing'] {
    color: var(--warn);
  }
  .packages {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .packages .sub {
    display: inline;
  }
  .packages button {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: none;
    padding: 5px 12px;
    font-size: 13px;
  }
  .packages button:hover {
    border-color: var(--muted);
  }
  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .note {
    margin-right: auto;
    color: var(--muted);
    font-size: 12.5px;
  }
  footer button {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: none;
    padding: 6px 16px;
  }
  footer .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--ink);
    font-weight: 600;
  }
  footer .primary:disabled {
    opacity: 0.6;
  }
</style>
