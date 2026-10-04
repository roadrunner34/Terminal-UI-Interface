<script lang="ts">
  import { session } from '../lib/session.svelte'

  let { viewingSubagent }: { viewingSubagent: boolean } = $props()
  let text = $state('')
  let input: HTMLTextAreaElement

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
  <div class="box" class:disabled={!session.running}>
    <textarea
      bind:this={input}
      bind:value={text}
      oninput={resize}
      onkeydown={onKey}
      rows="1"
      disabled={!session.running}
      placeholder={session.running ? 'Message the agent' : 'Start a session to send messages'}
      aria-label="Message"
    ></textarea>
    {#if session.busy}
      <button class="stop" onclick={() => window.agentDeck.abort()} title="Interrupt (Esc)">Interrupt</button>
    {/if}
    <button class="send" onclick={send} disabled={!text.trim() || !session.running}>Send</button>
  </div>
  <p class="hint">
    {#if viewingSubagent}
      Messages go to the main session.
    {:else}
      Enter to send, Shift+Enter for a new line{session.busy ? ', Esc to interrupt' : ''}.
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
    background: var(--running);
    border-color: var(--running);
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
  .hint {
    max-width: 860px;
    margin: 6px auto 0;
    font-size: 12px;
    color: var(--muted);
  }
</style>
