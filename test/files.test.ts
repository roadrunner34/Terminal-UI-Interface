import { execFileSync } from 'node:child_process'
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

  // Windows looks a bare command name up in the working directory before PATH.
  // An empty git.exe can't start, so picking it would show up as the walk
  // fallback listing the ignored file.
  it.runIf(process.platform === 'win32')('never runs a git.exe from the project folder', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'agent-deck-planted-'))
    // Some shells set this, which hides the lookup; an app started from
    // Explorer doesn't have it.
    const noCwd = process.env.NoDefaultCurrentDirectoryInExePath
    delete process.env.NoDefaultCurrentDirectoryInExePath
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo })
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
      writeFileSync(join(repo, 'ignored.txt'), '')
      writeFileSync(join(repo, 'kept.txt'), '')
      writeFileSync(join(repo, 'git.exe'), '')
      const files = await listProjectFiles(repo)
      expect(files).toContain('kept.txt')
      expect(files).not.toContain('ignored.txt')
    } finally {
      if (noCwd !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = noCwd
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
