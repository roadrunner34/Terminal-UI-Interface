// Ending an agent means ending everything it started too: shells, MCP
// servers, subagent processes. On Windows taskkill /T ends the tree. Elsewhere
// the child leads a process group of its own (see groupSpawnOptions), and the
// whole group is signalled.
import { spawn, type ChildProcess } from 'node:child_process'

/** How long a process group gets after SIGTERM before it is sent SIGKILL. */
export const KILL_GRACE_MS = 3000

/** Spawn options that make the child lead its own process group, off Windows. */
export function groupSpawnOptions(platform: NodeJS.Platform = process.platform): { detached?: true } {
  // On Windows `detached` opens a console of its own instead; taskkill /T covers the tree there.
  return platform === 'win32' ? {} : { detached: true }
}

export interface KillOptions {
  platform?: NodeJS.Platform
  /** process.kill, replaceable in tests. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** Starts taskkill, replaceable in tests. */
  taskkill?: (pid: number) => void
  graceMs?: number
}

/** Ends `proc` and everything it started. Does nothing once it has exited. */
export function killTree(proc: ChildProcess, opts: KillOptions = {}): void {
  const pid = proc.pid
  if (!pid || proc.exitCode !== null || proc.signalCode !== null) return
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') {
    const taskkill = opts.taskkill ?? ((p: number) => spawn('taskkill', ['/pid', String(p), '/T', '/F'], { windowsHide: true }))
    taskkill(pid)
    return
  }
  const kill = opts.kill ?? ((p: number, s: NodeJS.Signals) => process.kill(p, s))
  try {
    // A negative pid signals the whole group.
    kill(-pid, 'SIGTERM')
  } catch {
    // Not a group leader (spawned without groupSpawnOptions): end the child alone.
    proc.kill('SIGTERM')
    return
  }
  // Whatever ignored SIGTERM (the leader may already be gone) is stopped for good.
  const timer = setTimeout(() => {
    try {
      kill(-pid, 'SIGKILL')
    } catch {
      // The group has already exited.
    }
  }, opts.graceMs ?? KILL_GRACE_MS)
  timer.unref?.()
}
