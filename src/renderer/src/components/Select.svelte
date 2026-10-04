<script lang="ts">
  // A labelled native <select>: keyboard and screen-reader behaviour for free,
  // styled to sit in the top bar.
  let {
    label,
    value,
    options,
    disabled = false,
    title = '',
    onchange
  }: {
    label: string
    value: string
    options: { value: string; label: string }[]
    disabled?: boolean
    title?: string
    onchange: (value: string) => void
  } = $props()
</script>

<label class="select" class:disabled {title}>
  <span class="label">{label}</span>
  <select {value} {disabled} onchange={(e) => onchange(e.currentTarget.value)}>
    {#each options as opt (opt.value)}
      <option value={opt.value}>{opt.label}</option>
    {/each}
  </select>
</label>

<style>
  .select {
    position: relative;
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 26px 4px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--raised);
    font-size: 14px;
    cursor: pointer;
  }
  .select:hover:not(.disabled) {
    border-color: var(--muted);
  }
  .select:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* Chevron drawn in CSS so the native arrow can be hidden. */
  .select::after {
    content: '';
    position: absolute;
    right: 10px;
    top: 50%;
    width: 6px;
    height: 6px;
    border-right: 1.5px solid var(--muted);
    border-bottom: 1.5px solid var(--muted);
    transform: translateY(-70%) rotate(45deg);
    pointer-events: none;
  }
  .disabled {
    opacity: 0.5;
    cursor: default;
  }
  .label {
    color: var(--muted);
    font-size: 13px;
  }
  select {
    appearance: none;
    border: none;
    background: none;
    padding: 0;
    outline: none;
    cursor: inherit;
    max-width: 180px;
    text-overflow: ellipsis;
  }
  option {
    background: var(--raised);
    color: var(--text);
  }
</style>
