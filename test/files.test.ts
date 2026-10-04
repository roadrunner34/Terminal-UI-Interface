import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { listProjectFiles } from '../src/main/files'

describe('listProjectFiles', () => {
  it('lists a git project’s files relative to its root', async () => {
    const files = await listProjectFiles(join(__dirname, '..'))
    expect(files).toContain('package.json')
    expect(files).toContain('src/main/files.ts')
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
  })

  const dir = mkdtempSync(join(tmpdir(), 'agent-deck-files-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('walks a folder without git, skipping heavy and hidden folders', async () => {
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
    mkdirSync(join(dir, '.cache'))
    writeFileSync(join(dir, 'README.md'), '')
    writeFileSync(join(dir, 'src', 'lib', 'a.ts'), '')
    writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), '')
    writeFileSync(join(dir, '.cache', 'junk'), '')
    expect((await listProjectFiles(dir)).sort()).toEqual(['README.md', 'src/lib/a.ts'])
  })
})
