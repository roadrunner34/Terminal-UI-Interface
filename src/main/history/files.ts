import { readdir, readFile } from 'node:fs/promises'

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
