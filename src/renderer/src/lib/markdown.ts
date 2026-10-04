import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { Marked } from 'marked'

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined
      const html = language ? hljs.highlight(text, { language }).value : escapeHtml(text)
      return `<pre class="hljs"><code>${html}</code></pre>`
    }
  }
})

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') node.setAttribute('target', '_blank')
})

export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(marked.parse(src, { async: false }) as string)
}

/** A file's contents as highlighted HTML, by extension; plain (escaped) when unknown. */
export function highlightFile(path: string, code: string): string {
  const ext = /\.([\w]+)$/.exec(path)?.[1]?.toLowerCase()
  const language = ext && hljs.getLanguage(ext) ? ext : ext === 'svelte' || ext === 'vue' ? 'xml' : undefined
  return language ? hljs.highlight(code, { language }).value : escapeHtml(code)
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
