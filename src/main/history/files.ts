import { readdir, readFile, stat } from 'node:fs/promises'

const memo = new Map<string, { mtimeMs: number; size: number; value: unknown }>()

/**
 * A per-file result, recomputed only when the file changes (mtime or size).
 * Listing history parses every session file, so unchanged ones come from here.
 */
export async function memoByFile<T>(path: string, key: string, compute: () => Promise<T>): Promise<T> {
  const st = await stat(path)
  const k = `${key}\0${path}`
  const hit = memo.get(k)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value as T
  const value = await compute()
  memo.set(k, { mtimeMs: st.mtimeMs, size: st.size, value })
  return value
}

/** Every parseable record in a JSONL file; a torn last line is skipped. */
export async function readRecords(path: string): Promise<any[]> {
  const out: any[] = []
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A session still being written can end mid-line.
    }
  }
  return out
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/** Windows paths compare case-insensitively and with either slash. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/[\\/]+$/, '').replace(/\\/g, '/')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

export function time(ts: unknown): number {
  const t = typeof ts === 'number' ? ts : Date.parse(String(ts))
  return Number.isFinite(t) ? t : 0
}

export function oneLine(text: string, max = 80): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
