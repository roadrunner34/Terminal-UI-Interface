<script lang="ts">
  import { onDestroy } from 'svelte'
  import { renderMarkdown } from '../lib/markdown'

  let { text }: { text: string } = $props()

  // Parsing, highlighting and sanitizing cost grows with the message, so while
  // it streams, re-render at most once per frame instead of on every delta.
  // The first render is immediate, so replays and finished messages appear at once.
  // svelte-ignore state_referenced_locally
  let html = $state(renderMarkdown(text))
  // svelte-ignore state_referenced_locally
  let rendered = text
  let frame = 0

  $effect(() => {
    if (text === rendered || frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      rendered = text
      html = renderMarkdown(text)
    })
  })

  onDestroy(() => cancelAnimationFrame(frame))
</script>

<!-- No wrapper: the parent styles it (Transcript's scoped .md rules). -->
{@html html}
