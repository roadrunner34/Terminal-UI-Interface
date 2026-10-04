import { describe, expect, it } from 'vitest'
import type { Block } from '../src/shared/session'
import { foldContext, lineDiff, taskList, toolView } from '../src/shared/tools'

const tool = (name: string, input: unknown, output = '', status: 'running' | 'done' | 'error' = 'done'): Block => ({
  type: 'tool',
  id: `${name}-${Math.random()}`,
  name,
  input,
  output,
  status
})

describe('lineDiff', () => {
  it('keeps common lines and marks changes', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'B' },
      { op: ' ', text: 'c' },
      { op: '+', text: 'd' }
    ])
  })

  it('treats an empty side as nothing, not one blank line', () => {
    expect(lineDiff('', 'x')).toEqual([{ op: '+', text: 'x' }])
    expect(lineDiff('x', '')).toEqual([{ op: '-', text: 'x' }])
  })

  it('falls back to remove-then-add for huge inputs', () => {
    const big = Array.from({ length: 600 }, (_, i) => `l${i}`).join('\n')
    const out = lineDiff(big, big + '\nmore')
    expect(out.filter((l) => l.op === '-')).toHaveLength(600)
    expect(out.filter((l) => l.op === '+')).toHaveLength(601)
  })
})

describe('foldContext', () => {
  it('folds long unchanged runs away from changes', () => {
    const lines = lineDiff(Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n'), [...Array.from({ length: 11 }, (_, i) => `l${i}`), 'changed'].join('\n'))
    const shown = foldContext(lines, 2)
    expect(shown[0]).toEqual({ op: 'skip', count: 9 })
    expect(shown.slice(1).map((l) => l.op)).toEqual([' ', ' ', '-', '+'])
  })
})

describe('toolView', () => {
  it('diffs a Claude Edit', () => {
    const v = toolView('Edit', { file_path: 'D:\\p\\a.ts', old_string: 'const a = 1', new_string: 'const a = 2\nconst b = 3' })
    expect(v).toMatchObject({ kind: 'edit', path: 'D:\\p\\a.ts', added: 2, removed: 1 })
  })

  it('diffs each of a Pi edit’s replacements', () => {
    const v = toolView('edit', { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'p', newText: 'p\nq' }] })
    expect(v.kind === 'edit' && v.hunks.length).toBe(2)
    expect(v).toMatchObject({ added: 2, removed: 1 })
  })

  it('recognises writes, shell commands and reads from either agent', () => {
    expect(toolView('Write', { file_path: 'a.md', content: 'a\nb' })).toEqual({ kind: 'write', path: 'a.md', content: 'a\nb', lines: 2 })
    expect(toolView('bash', { command: 'ls', timeout: '10' })).toEqual({ kind: 'bash', command: 'ls', description: undefined })
    expect(toolView('PowerShell', { command: 'dir', description: 'List' })).toMatchObject({ kind: 'bash', description: 'List' })
    expect(toolView('Read', { file_path: 'a.ts', offset: 10, limit: 20 })).toEqual({ kind: 'read', path: 'a.ts', range: 'lines 10–29' })
    expect(toolView('read', { path: 'a.ts' })).toEqual({ kind: 'read', path: 'a.ts', range: undefined })
  })

  it('falls back to generic for anything else', () => {
    expect(toolView('Grep', { pattern: 'x' })).toEqual({ kind: 'generic' })
    expect(toolView('Edit', null)).toEqual({ kind: 'generic' })
  })
})

describe('taskList', () => {
  it('follows Claude’s TaskCreate and TaskUpdate', () => {
    const tasks = taskList([
      tool('TaskCreate', { subject: 'Write tests', activeForm: 'Writing tests' }, 'Task #1 created successfully: Write tests'),
      tool('TaskCreate', { subject: 'Ship' }, 'Task #2 created successfully: Ship'),
      tool('TaskCreate', { subject: 'Never made' }, 'boom', 'error'),
      tool('TaskUpdate', { taskId: '1', status: 'in_progress' }),
      tool('TaskUpdate', { taskId: '1', status: 'completed' }),
      tool('TaskUpdate', { taskId: '2', status: 'in_progress', subject: 'Ship it' })
    ])
    expect(tasks).toEqual([
      { id: '1', subject: 'Write tests', activeForm: 'Writing tests', status: 'completed' },
      { id: '2', subject: 'Ship it', activeForm: undefined, status: 'in_progress' }
    ])
  })

  it('drops deleted tasks', () => {
    const tasks = taskList([
      tool('TaskCreate', { subject: 'A' }, 'Task #1 created successfully: A'),
      tool('TaskUpdate', { taskId: 1, status: 'deleted' })
    ])
    expect(tasks).toEqual([])
  })

  it('takes TodoWrite’s list as a whole', () => {
    const tasks = taskList([
      tool('TodoWrite', { todos: [{ content: 'old', status: 'pending' }] }),
      tool('TodoWrite', { todos: [{ content: 'a', status: 'completed', activeForm: 'Doing a' }, { content: 'b', status: 'in_progress' }] })
    ])
    expect(tasks.map((t) => [t.subject, t.status])).toEqual([
      ['a', 'completed'],
      ['b', 'in_progress']
    ])
  })
})
