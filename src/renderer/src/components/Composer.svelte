<script lang="ts">
  import { session } from '../lib/session.svelte'

  let { viewingSubagent }: { viewingSubagent: boolean } = $props()
  let text = $state('')
  let input: HTMLTextAreaElement

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
    if (session.running) window.agentDeck.configure({ mode: planning ? 'auto' : 'plan' })
  }

  async function runPlan() {
    await window.agentDeck.configure({ mode: 'auto' })
    await window.agentDeck.send('The plan is approved. Go ahead and implement it.')
  }

  async function send() {
    const msg = text.trim()
    if (!msg || !session.running) return
    text = ''
    resize()
    await window.agentDeck.send(msg)
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Tab' && e.shiftKey && session.running) {
      // Same shortcut as Claude Code's terminal UI.
      e.preventDefault()
      toggleMode()
    } else if (e.key === 'Escape' && session.busy) {
      window.agentDeck.abort()
    }
  }

  function resize() {
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 260)}px`
  }
</script>

<div class="composer">
  {#if planReady}
    <div class="plan" role="status">
      <span>Plan ready. Run it, or keep chatting to refine it.</span>
      <button class="run" onclick={runPlan}>Switch to Auto and run</button>
    </div>
  {/if}
  <div class="box" class:disabled={!session.running} class:planning={planning && session.running}>
    <textarea
      bind:this={input}
      bind:value={text}
      oninput={resize}
      onkeydown={onKey}
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
      <button class="stop" onclick={() => window.agentDeck.abort()} title="Interrupt (Esc)">Interrupt</button>
    {/if}
    <button class="send" onclick={send} disabled={!text.trim() || !session.running}>Send</button>
  </div>
  <p class="hint" class:sticky={viewingSubagent}>
    {#if viewingSubagent}
      Messages go to the main session.
    {:else}
      Enter to send, Shift+Enter for a new line, Shift+Tab for {planning ? 'Auto' : 'Plan'} mode{session.busy
        ? ', Esc to interrupt'
        : ''}.
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
  .box:focus-within {
    border-color: var(--muted);
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
</style>
