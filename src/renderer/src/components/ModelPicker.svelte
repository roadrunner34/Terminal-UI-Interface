<script lang="ts">
  // Searchable model picker. Pi can expose hundreds of models (e.g. via
  // OpenRouter), which a native <select> can't navigate usefully.
  import { tick } from 'svelte'

  type Option = { value: string; label: string }
  let {
    value,
    options,
    title = '',
    onchange
  }: { value: string; options: Option[]; title?: string; onchange: (value: string) => void } = $props()

  const LIMIT = 150
  let open = $state(false)
  let query = $state('')
  let active = $state(0)
  let root: HTMLDivElement
  let input = $state<HTMLInputElement>()
  let list = $state<HTMLUListElement>()

  const selected = $derived(options.find((o) => o.value === value) ?? { value, label: value || 'Default' })
  // Every search term must appear in the name or id, in any order.
  const filtered = $derived.by(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return options
    return options.filter((o) => {
      const hay = `${o.label} ${o.value}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  })
  // Render a bounded list so 400+ models stay snappy.
  const matches = $derived(filtered.slice(0, LIMIT))
  const hidden = $derived(Math.max(0, filtered.length - LIMIT))

  async function show() {
    open = true
    query = ''
    active = Math.max(0, options.findIndex((o) => o.value === value))
    await tick()
    input?.focus()
    scrollActive()
  }

  function close() {
    open = false
  }

  function choose(opt: Option) {
    close()
    if (opt.value !== value) onchange(opt.value)
  }

  function scrollActive() {
    list?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = matches.length
      if (n) active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      tick().then(scrollActive)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = matches[active]
      if (opt) choose(opt)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  function onFocusOut(e: FocusEvent) {
    if (!root.contains(e.relatedTarget as Node)) close()
  }

  $effect(() => {
    void query
    active = 0
  })
</script>

<div class="picker" bind:this={root} onfocusout={onFocusOut}>
  <button class="trigger" {title} aria-haspopup="listbox" aria-expanded={open} onclick={() => (open ? close() : show())}>
    <span class="label">Model</span>
    <span class="value">{selected.label}</span>
  </button>

  {#if open}
    <div class="popover">
      <input
        bind:this={input}
        bind:value={query}
        onkeydown={onKey}
        role="combobox"
        aria-label="Search models"
        aria-expanded="true"
        aria-controls="model-list"
        aria-activedescendant={matches[active] ? `model-opt-${active}` : undefined}
        placeholder="Search {options.length} models"
        spellcheck="false"
        autocomplete="off"
      />
      <ul id="model-list" role="listbox" bind:this={list} aria-label="Models">
        {#each matches as opt, i (opt.value)}
          <!-- Keyboard selection goes through the combobox input (aria-activedescendant). -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id="model-opt-{i}"
            data-i={i}
            role="option"
            aria-selected={opt.value === value}
            class:active={i === active}
            onmousemove={() => (active = i)}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => choose(opt)}
          >
            <span class="name">{opt.label}</span>
            {#if opt.value && opt.value !== opt.label}<span class="id">{opt.value}</span>{/if}
          </li>
        {:else}
          <li class="none">No models match “{query}”.</li>
        {/each}
        {#if hidden}
          <li class="none">{hidden} more. Keep typing to narrow the list.</li>
        {/if}
      </ul>
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
  }
  .trigger {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 26px 4px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--raised);
    font-size: 14px;
    position: relative;
    max-width: 260px;
  }
  .trigger:hover {
    border-color: var(--muted);
  }
  .trigger::after {
    content: '';
    position: absolute;
    right: 10px;
    top: 50%;
    width: 6px;
    height: 6px;
    border-right: 1.5px solid var(--muted);
    border-bottom: 1.5px solid var(--muted);
    transform: translateY(-70%) rotate(45deg);
  }
  .label {
    color: var(--muted);
    font-size: 13px;
  }
  .value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 20;
    width: 380px;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.45);
    overflow: hidden;
  }
  input {
    width: 100%;
    border: none;
    border-bottom: 1px solid var(--line);
    background: var(--sunken);
    padding: 10px 12px;
    outline: none;
    font-size: 14px;
  }
  input::placeholder {
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 4px;
    max-height: 340px;
    overflow-y: auto;
  }
  li {
    display: flex;
    flex-direction: column;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 14px;
  }
  li.active {
    background: color-mix(in srgb, var(--running) 16%, transparent);
  }
  li[aria-selected='true'] .name {
    color: var(--running);
    font-weight: 600;
  }
  .id {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--muted);
  }
  .none {
    color: var(--muted);
    cursor: default;
    font-size: 13px;
  }
</style>
