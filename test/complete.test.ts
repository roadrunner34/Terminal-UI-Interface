import { describe, expect, it } from 'vitest'
import { applyCompletion, suggestCommands, suggestFiles, tokenAt } from '../src/shared/complete'
import { userContent } from '../src/main/agents/claude'

describe('tokenAt', () => {
  it('finds a command only at the start of the message', () => {
    expect(tokenAt('/comp', 5)).toEqual({ kind: 'command', query: 'comp', start: 0, end: 5 })
    expect(tokenAt('see /comp', 9)).toBeNull()
    expect(tokenAt('/compact now', 12)).toBeNull()
  })

  it('finds an @-mention anywhere', () => {
    expect(tokenAt('look at @src/sh please', 15)).toEqual({ kind: 'file', query: 'src/sh', start: 8, end: 15 })
    expect(tokenAt('@', 1)).toEqual({ kind: 'file', query: '', start: 0, end: 1 })
    expect(tokenAt('mail me@', 7)).toBeNull()
  })
})

describe('suggestions', () => {
  const commands = [{ name: 'compact', description: 'Compact the conversation. Keeps a summary.' }, { name: 'code-review:code-review' }, { name: 'context' }, { name: 'clear' }]

  it('ranks command prefixes first, then plugin-name prefixes', () => {
    expect(suggestCommands(commands, 'co').map((s) => s.value)).toEqual(['/compact', '/context', '/code-review:code-review'])
    expect(suggestCommands(commands, 'code').map((s) => s.value)).toEqual(['/code-review:code-review'])
    expect(suggestCommands(commands, 'compact')[0].detail).toBe('Compact the conversation.')
  })

  const files = ['src/shared/session.ts', 'src/renderer/src/lib/session.svelte.ts', 'test/session.test.ts', 'README.md', 'docs/my notes.md']

  it('ranks file-name matches over path matches over loose matches', () => {
    expect(suggestFiles(files, 'session').map((s) => s.value)).toEqual([
      '@src/shared/session.ts',
      '@test/session.test.ts',
      '@src/renderer/src/lib/session.svelte.ts'
    ])
    expect(suggestFiles(files, 'srshses').map((s) => s.value)).toEqual(['@src/shared/session.ts'])
    // "ses" is in session files' names; scattered letters elsewhere don't count then.
    expect(suggestFiles([...files, 'src/agents/pi.ts'], 'sess').map((s) => s.label)).not.toContain('pi.ts')
    expect(suggestFiles(files, 'readme')[0]).toEqual({ value: '@README.md', label: 'README.md', detail: undefined })
  })

  it('quotes paths with spaces', () => {
    expect(suggestFiles(files, 'my not')[0].value).toBe('@"docs/my notes.md"')
  })
})

describe('applyCompletion', () => {
  it('replaces the token and adds one space', () => {
    const text = 'look at @ses please'
    const token = tokenAt(text, 12)!
    expect(applyCompletion(text, token, '@src/shared/session.ts')).toEqual({ text: 'look at @src/shared/session.ts please', caret: 30 })
    expect(applyCompletion('/co', tokenAt('/co', 3)!, '/compact')).toEqual({ text: '/compact ', caret: 9 })
  })
})

describe('Claude prompt content', () => {
  it('sends plain text without images, blocks with them', () => {
    expect(userContent('hi', [])).toBe('hi')
    expect(userContent('what is this?', [{ mimeType: 'image/png', data: 'AAA' }])).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }
    ])
    expect(userContent('', [{ mimeType: 'image/jpeg', data: 'B' }])).toHaveLength(1)
  })
})
