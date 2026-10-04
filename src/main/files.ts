// Project files for @-mentions in the composer. Git knows what matters
// (tracked plus untracked, minus ignored); without git, walk the tree and skip
// the usual heavy folders.
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** Enough for any project you'd mention files in; keeps the list cheap to send. */
const MAX_FILES = 20_000
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', '.venv', 'venv', '__pycache__', 'target'])
const TTL_MS = 30_000

const cache = new Map<string, { at: number; files: Promise<string[]> }>()

/** Relative paths with forward slashes, cached briefly per folder. */
export function listProjectFiles(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files
  const files = gitFiles(cwd).catch(() => walk(cwd))
  cache.set(cwd, { at: Date.now(), files })
  return files
}

function gitFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err)
        resolve([...new Set(stdout.split('\0').filter(Boolean))].slice(0, MAX_FILES))
      }
    )
  })
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  const queue = [root]
  while (queue.length && out.length < MAX_FILES) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push(join(dir, e.name))
      } else if (e.isFile()) {
        out.push(relative(root, join(dir, e.name)).split('\\').join('/'))
        if (out.length >= MAX_FILES) break
      }
    }
  }
  return out
}
