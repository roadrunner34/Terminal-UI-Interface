<script lang="ts">
  import type { PromptAnswer } from '@shared/events'
  import { summarizeInput, type PendingPrompt } from '@shared/session'
  import { agent, deck } from '../lib/session.svelte'

  /** The oldest prompt the agent is blocked on; `waiting` counts the ones behind it. */
  let { pending, waiting = 0 }: { pending: PendingPrompt; waiting?: number } = $props()

  const p = $derived(pending.prompt)
  const tag = $derived(pending.scope === 'main' ? '' : deck.tags[pending.scope.subagentId])
  let showInput = $state(false)
  let text = $state('')
  /** AskUserQuestion: chosen labels per question. */
  let picked = $state<Record<string, string[]>>({})
  let card: HTMLDivElement

  // A fresh prompt starts clean and takes focus, so Enter/Esc answer it.
  $effect(() => {
    void pending.id
    showInput = false
    picked = {}
    text = pending.prompt.type === 'input' ? (pending.prompt.prefill ?? '') : ''
    queueMicrotask(() => (card?.querySelector('[data-default]') as HTMLElement | null)?.focus())
  })

  function answer(a: PromptAnswer) {
    agent.answerPrompt(pending.id, a)
  }

  function pick(question: string, label: string, multi: boolean) {
    const now = picked[question] ?? []
    picked[question] = multi ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label]
  }

  const allAnswered = $derived(p.type === 'questions' && p.questions.every((q) => picked[q.question]?.length))

  function submitAnswers() {
    if (p.type !== 'questions' || !allAnswered) return
    answer({ answers: Object.fromEntries(p.questions.map((q) => [q.question, picked[q.question].join(', ')])) })
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    answer(p.type === 'tool-approval' ? { allow: false } : { cancelled: true })
  }
</script>

<div class="card" role="alertdialog" aria-label="The agent is waiting for you" tabindex="-1" bind:this={card} onkeydown={onKey}>
  <div class="head">
    <span class="badge">Needs you</span>
    {#if tag}<span class="tag" title="From subagent {tag}">{tag}</span>{/if}
    {#if waiting}<span class="more">+{waiting} more waiting</span>{/if}
  </div>

  {#if p.type === 'tool-approval'}
    <p class="title">Allow <strong>{p.tool}</strong>{p.description ? `: ${p.description}` : '?'}</p>
    {#if summarizeInput(p.input)}
      <button class="summary" onclick={() => (showInput = !showInput)} aria-expanded={showInput}>
        <code>{summarizeInput(p.input)}</code>
        <span class="toggle">{showInput ? 'Hide' : 'Details'}</span>
      </button>
    {:else}
      <button class="summary" onclick={() => (showInput = !showInput)} aria-expanded={showInput}>
        <span class="toggle">{showInput ? 'Hide input' : 'Show input'}</span>
      </button>
    {/if}
    {#if showInput}<pre>{JSON.stringify(p.input, null, 2)}</pre>{/if}
    <div class="actions">
      <button class="primary" data-default onclick={() => answer({ allow: true })}>Allow</button>
      {#if p.canAlways}
        <button onclick={() => answer({ allow: true, always: true })} title="Don't ask again for this in this session"
          >Allow for session</button
        >
      {/if}
      <button class="deny" onclick={() => answer({ allow: false })}>Deny</button>
      <span class="keys">Enter to allow, Esc to deny</span>
    </div>
  {:else if p.type === 'questions'}
    {#each p.questions as q (q.question)}
      <fieldset>
        <legend>
          {#if q.header}<span class="qhead">{q.header}</span>{/if}
          {q.question}
          {#if q.multiSelect}<span class="hint">Choose any</span>{/if}
        </legend>
        <div class="options">
          {#each q.options as o (o.label)}
            <button
              class="option"
              class:on={picked[q.question]?.includes(o.label)}
              aria-pressed={!!picked[q.question]?.includes(o.label)}
              title={o.description}
              onclick={() => pick(q.question, o.label, q.multiSelect)}
            >
              <span class="olabel">{o.label}</span>
              {#if o.description}<span class="odesc">{o.description}</span>{/if}
            </button>
          {/each}
        </div>
      </fieldset>
    {/each}
    <div class="actions">
      <button class="primary" data-default disabled={!allAnswered} onclick={submitAnswers}>Answer</button>
      <button onclick={() => answer({ cancelled: true })}>Skip</button>
    </div>
  {:else if p.type === 'select'}
    <p class="title">{p.title}</p>
    <div class="options">
      {#each p.options as o, i (o)}
        <button class="option" data-default={i === 0 ? '' : undefined} onclick={() => answer({ value: o })}>
          <span class="olabel">{o}</span>
        </button>
      {/each}
    </div>
    <div class="actions">
      <button onclick={() => answer({ cancelled: true })}>Dismiss</button>
    </div>
  {:else if p.type === 'confirm'}
    <p class="title">{p.title}</p>
    {#if p.message}<p class="message">{p.message}</p>{/if}
    <div class="actions">
      <button class="primary" data-default onclick={() => answer({ confirmed: true })}>Yes</button>
      <button onclick={() => answer({ confirmed: false })}>No</button>
    </div>
  {:else}
    <p class="title">{p.title}</p>
    <form
      class="field"
      onsubmit={(e) => {
        e.preventDefault()
        answer({ value: text })
      }}
    >
      {#if p.multiline}
        <textarea data-default bind:value={text} rows="5" placeholder={p.placeholder}></textarea>
      {:else}
        <input data-default bind:value={text} placeholder={p.placeholder} />
      {/if}
      <div class="actions">
        <button class="primary" type="submit">Submit</button>
        <button type="button" onclick={() => answer({ cancelled: true })}>Cancel</button>
      </div>
    </form>
  {/if}
</div>

<style>
  .card {
    max-width: 860px;
    margin: 0 auto 8px;
    padding: 10px 12px 12px 14px;
    border: 1px solid color-mix(in srgb, var(--warn) 55%, var(--line));
    border-left: 3px solid var(--warn);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--warn) 6%, var(--raised));
    font-size: 14px;
    max-height: 50vh;
    overflow: auto;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .badge {
    font-size: 12px;
    font-weight: 600;
    color: var(--warn);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .tag {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    padding: 0 5px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  .more {
    margin-left: auto;
    color: var(--muted);
    font-size: 12px;
  }
  .title {
    margin: 0 0 6px;
  }
  .message {
    margin: 0 0 6px;
    color: var(--muted);
  }
  .summary {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--sunken);
    text-align: left;
  }
  .summary code {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .toggle {
    color: var(--accent);
    font-size: 12px;
    flex-shrink: 0;
  }
  pre {
    margin: 6px 0 0;
    padding: 8px 10px;
    max-height: 220px;
    overflow: auto;
    background: var(--sunken);
    border-radius: var(--radius-sm);
    font-size: 12.5px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--muted);
  }
  fieldset {
    border: none;
    margin: 0 0 10px;
    padding: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 6px;
  }
  .qhead {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    padding: 0 5px;
    margin-right: 6px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  .hint {
    margin-left: 6px;
    color: var(--muted);
    font-size: 12px;
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .option {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--sunken);
    text-align: left;
  }
  .option:hover {
    border-color: var(--muted);
  }
  .option.on {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--sunken));
  }
  .olabel {
    font-weight: 500;
  }
  .odesc {
    color: var(--muted);
    font-size: 13px;
  }
  .field input,
  .field textarea {
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--sunken);
    resize: vertical;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }
  .actions button {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: none;
    padding: 5px 14px;
  }
  .actions .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--ink);
    font-weight: 600;
  }
  .actions .primary:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .actions .deny {
    color: var(--error);
    border-color: color-mix(in srgb, var(--error) 50%, transparent);
  }
  .keys {
    margin-left: auto;
    color: var(--muted);
    font-size: 12px;
  }
</style>
