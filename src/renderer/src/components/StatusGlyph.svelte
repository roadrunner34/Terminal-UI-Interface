<script lang="ts">
  // Status as shape as well as colour: a ring while running, a tick when
  // done, a cross on failure. Screen readers get the word.
  let { status }: { status: 'running' | 'done' | 'error' } = $props()
  const word = { running: 'Running', done: 'Finished', error: 'Failed' }
</script>

<span class="glyph" data-status={status} aria-hidden="true">
  {#if status === 'done'}
    <svg viewBox="0 0 12 12"><path d="M2.5 6.5l2.2 2.2L9.5 3.8" /></svg>
  {:else if status === 'error'}
    <svg viewBox="0 0 12 12"><path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6" /></svg>
  {/if}
</span>
<span class="sr-only">{word[status]}</span>

<style>
  .glyph {
    flex-shrink: 0;
    display: inline-grid;
    place-items: center;
    width: 12px;
    height: 12px;
  }
  svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  [data-status='done'] {
    color: var(--done);
  }
  [data-status='error'] {
    color: var(--error);
  }
  /* A ring with one bright quarter that turns; with reduced motion it simply
     stays still, which still reads as "in progress". */
  [data-status='running'] {
    border-radius: 50%;
    border: 1.8px solid color-mix(in srgb, var(--running) 30%, transparent);
    border-top-color: var(--running);
    animation: turn 0.9s linear infinite;
  }
  @keyframes turn {
    to {
      transform: rotate(360deg);
    }
  }
</style>
