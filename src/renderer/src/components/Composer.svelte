<script lang="ts">
  import { tick } from 'svelte'
  import { applyCompletion, suggestCommands, suggestFiles, tokenAt, type Suggestion } from '@shared/complete'
  import type { ImageAttachment } from '@shared/events'
  import { activeTab, agent, commandsFor, session } from '../lib/session.svelte'
  import PromptCard from './PromptCard.svelte'

  let { viewingSubagent }: { viewingSubagent: boolean } = $props()
  /** The active tab's unsent text: each tab keeps its own draft. */
  const tab = $derived(activeTab())
  let input: HTMLTextAreaElement

  // Autocomplete: `/command` at the start, `@path` anywhere.
  let caret = $state(0)
  let picked = $state(0)
  /** Start of a token the user dismissed with Esc; it stays closed until they move on. */
  let dismissed = $state(-1)
  let files = $state<string[] | null>(null)
  let filesAt = 0

  const token = $derived(session.running ? tokenAt(tab.draft, caret) : null)
  const suggestions = $derived.by((): Suggestion[] => {
    if (!token || token.start === dismissed) return []
    if (token.kind === 'command') return suggestCommands(commandsFor(session.agent), token.query)
    return files ? suggestFiles(files, token.query) : []
  })

  // Fetch the file list when an @-mention starts; main caches it briefly.
  $effect(() => {
    if (token?.kind !== 'file' || Date.now() - filesAt < 30_000) return
    filesAt = Date.now()
    agent.listFiles().then((list) => (files = list))
  })

  $effect(() => {
    void token?.query
    picked = 0
  })

  function syncCaret() {
    caret = input?.selectionStart ?? 0
    if (token?.start !== dismissed) dismissed = -1
  }

  async function accept(s: Suggestion) {
    if (!token) return
    const next = applyCompletion(tab.draft, token, s.value)
    tab.draft = next.text
    await tick()
    input.setSelectionRange(next.caret, next.caret)
    caret = next.caret
    input.focus()
    resize()
  }

  // Images: pasted or dropped, sent with the next message.
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  /** The API's limit is 5 MB per image once base64-encoded. */
  const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024
  const MAX_IMAGES = 5
  let images = $state<ImageAttachment[]>([])
  let dragging = $state(false)

  async function addImages(list: File[]) {
    for (const file of list) {
      if (!IMAGE_TYPES.includes(file.type)) continue
      if (images.length >= MAX_IMAGES) {
        session.error = `Up to ${MAX_IMAGES} images per message.`
        return
      }
      if (file.size > MAX_IMAGE_BYTES) {
        session.error = `${file.name || 'That image'} is too large: images can be up to 3.75 MB.`
        continue
      }
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      images.push({ mimeType: file.type, data: url.slice(url.indexOf(',') + 1) })
    }
  }

  function onPaste(e: ClipboardEvent) {
    const pasted = [...(e.clipboardData?.files ?? [])].filter((f) => IMAGE_TYPES.includes(f.type))
    if (!pasted.length) return
    // Keep any text that came along (e.g. copied from a document); take over only for a bare image.
    if (!e.clipboardData?.getData('text/plain')) e.preventDefault()
    addImages(pasted)
  }

  function onDrop(e: DragEvent) {
    dragging = false
    const dropped = [...(e.dataTransfer?.files ?? [])]
    if (!dropped.length) return
    e.preventDefault()
    addImages(dropped)
  }

  function onDragOver(e: DragEvent) {
    if (!session.running || !e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    dragging = true
  }

  const planning = $derived(session.config.mode === 'plan')
  // A plan-mode turn that ended with an answer (or Claude's ExitPlanMode
  // call) has a plan waiting for approval.
  const planReady = $derived.by(() => {
    if (!session.running || session.busy || !planning) return false
    const last = session.transcripts.main.at(-1)
    if (last?.type === 'assistant') return !!last.text.trim()
    return last?.type === 'tool' && last.name === 'ExitPlanMode'
  })

  function toggleMode() {
    if (session.running) agent.configure({ mode: planning ? 'auto' : 'plan' })
  }

  function runPlan() {
    agent.approvePlan()
  }

  async function send() {
    const msg = tab.draft.trim()
    if ((!msg && !images.length) || !session.running) return
    // Plain objects: $state proxies can't cross IPC.
    const attached = images.map(({ mimeType, data }) => ({ mimeType, data }))
    tab.draft = ''
    images = []
    resize()
    await agent.send(msg, attached)
  }

  function onKey(e: KeyboardEvent) {
    if (suggestions.length && !e.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        picked = (picked + step + suggestions.length) % suggestions.length
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        accept(suggestions[picked])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        dismissed = token?.start ?? -1
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Tab' && e.shiftKey && session.running) {
      // Same shortcut as Claude Code's terminal UI.
      e.preventDefault()
      toggleMode()
    } else if (e.key === 'Escape' && session.busy) {
      agent.abort()
    }
  }

  function resize() {
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 260)}px`
  }
</script>

<div class="composer">
  {#if session.prompts.length}
    <PromptCard pending={session.prompts[0]} waiting={session.prompts.length - 1} />
  {/if}
  {#if planReady}
    <div class="plan" role="status">
      <span>Plan ready. Run it, or keep chatting to refine it.</span>
      <button class="run" onclick={runPlan}>Switch to Auto and run</button>
    </div>
  {/if}
  {#if images.length}
    <div class="attachments" aria-label="Attached images">
      {#each images as img, i (img.data.slice(-24) + i)}
        <div class="thumb">
          <img src="data:{img.mimeType};base64,{img.data}" alt="Attached image {i + 1}" />
          <button onclick={() => images.splice(i, 1)} aria-label="Remove image {i + 1}" title="Remove">×</button>
        </div>
      {/each}
    </div>
  {/if}
  <div
    class="box"
    class:disabled={!session.running}
    class:planning={planning && session.running}
    class:dragging
    role="group"
    aria-label="Message composer"
    ondragover={onDragOver}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
  >
    {#if suggestions.length}
      <ul class="suggest" id="composer-suggestions" role="listbox" aria-label={token?.kind === 'command' ? 'Commands' : 'Files'}>
        {#each suggestions as s, i (s.value)}
          <li
            id="suggestion-{i}"
            role="option"
            aria-selected={i === picked}
            class:on={i === picked}
            onmousedown={(e) => {
              e.preventDefault()
              accept(s)
            }}
          >
            <span class="slabel">{s.label}</span>
            {#if s.detail}<span class="sdetail">{s.detail}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    <textarea
      bind:this={input}
      bind:value={tab.draft}
      oninput={() => {
        resize()
        syncCaret()
      }}
      onkeydown={onKey}
      onkeyup={(e) => (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') && !suggestions.length && syncCaret()}
      onclick={syncCaret}
      onpaste={onPaste}
      aria-autocomplete="list"
      aria-controls={suggestions.length ? 'composer-suggestions' : undefined}
      aria-activedescendant={suggestions.length ? `suggestion-${picked}` : undefined}
      rows="1"
      disabled={!session.running}
      placeholder={session.running
        ? planning
          ? 'Describe what to plan. Nothing is changed in Plan mode.'
          : 'Message the agent'
        : session.replay
          ? 'Continue this session to reply'
          : 'Start a session to send messages'}
      aria-label="Message"
    ></textarea>
    {#if session.busy}
      <button class="stop" onclick={() => agent.abort()} title="Interrupt (Esc)">Interrupt</button>
    {/if}
    <button class="send" onclick={send} disabled={(!tab.draft.trim() && !images.length) || !session.running}>Send</button>
  </div>
  <!-- A prompt card has its own keys; the composer's would contradict them. -->
  <p class="hint" class:sticky={viewingSubagent} class:hidden={session.prompts.length > 0}>
    {#if viewingSubagent}
      Messages go to the main session.
    {:else}
      Enter to send, Shift+Enter for a new line, / for commands, @ for files, Shift+Tab for {planning ? 'Auto' : 'Plan'}
      mode{session.busy ? ', Esc to interrupt' : ''}. Paste or drop images to attach them.
    {/if}
  </p>
</div>

<style>
  .composer {
    padding: 8px 28px 16px;
  }
  .box {
    max-width: 860px;
    margin: 0 auto;
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 8px 8px 14px;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .box {
    position: relative;
  }
  .box:focus-within {
    border-color: var(--muted);
  }
  .box.dragging {
    border-color: var(--accent);
    border-style: dashed;
  }

  .suggest {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 5;
    margin: 0;
    padding: 4px;
    list-style: none;
    max-height: 300px;
    overflow-y: auto;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.35);
  }
  .suggest li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 5px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 14px;
  }
  .suggest li.on {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }
  .slabel {
    flex-shrink: 0;
    font-family: var(--mono);
    font-size: 13px;
  }
  .sdetail {
    min-width: 0;
    color: var(--muted);
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachments {
    max-width: 860px;
    margin: 0 auto 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .thumb {
    position: relative;
    width: 64px;
    height: 64px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--sunken);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .thumb button {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 20px;
    height: 20px;
    padding: 0;
    line-height: 18px;
    border: none;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.65);
    color: #fff;
    font-size: 14px;
  }
  .box.planning {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
  }
  .plan {
    max-width: 860px;
    margin: 0 auto 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 8px 8px 14px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line));
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--accent) 8%, var(--raised));
    font-size: 14px;
  }
  .run {
    flex-shrink: 0;
    background: var(--accent);
    border-color: var(--accent);
    color: var(--ink);
    font-weight: 600;
  }
  .box.disabled {
    opacity: 0.6;
  }
  textarea {
    flex: 1;
    resize: none;
    border: none;
    outline: none;
    background: none;
    padding: 5px 0;
    line-height: 1.5;
    max-height: 260px;
  }
  textarea::placeholder {
    color: var(--muted);
  }
  button {
    border-radius: var(--radius-sm);
    padding: 5px 14px;
    font-size: 14px;
    border: 1px solid var(--line);
    background: none;
  }
  .send {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--ink);
    font-weight: 600;
  }
  .send:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .stop {
    color: var(--error);
    border-color: color-mix(in srgb, var(--error) 50%, transparent);
  }
  /* Key hints only while typing; the subagent note always shows, since it changes where messages go. */
  .hint {
    max-width: 860px;
    margin: 6px auto 0;
    font-size: 12px;
    color: var(--muted);
    visibility: hidden;
  }
  .composer:focus-within .hint,
  .hint.sticky {
    visibility: visible;
  }
  .composer .hint.hidden {
    visibility: hidden;
  }
</style>
