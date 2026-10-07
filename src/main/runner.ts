// One-shot CLI runs outside a session (`pi mcp list`, `pi install`, …),
// launched the same way as agents (see resolve.ts).
import { spawn } from 'node:child_process'
import { quoteCommand, resolveLaunch, SAFE_ARG } from './resolve'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface RunOptions {
  cwd: string
  env?: Record<string, string>
  /** Kill the run after this long; 0 or absent waits forever. */
  timeoutMs?: number
  /** Each complete output line as it arrives. */
  onLine?: (line: string, stream: 'out' | 'err') => void
}

export interface Run {
  done: Promise<RunResult>
  kill(): void
}

/** Starts `command args`; `done` never rejects (a launch failure is code null plus stderr). */
export function run(command: string, args: string[], opts: RunOptions): Run {
  const launch = resolveLaunch(command, args)
  const bad = launch.shell ? args.find((a) => !SAFE_ARG.test(a)) : undefined
  if (bad !== undefined) {
    const stderr = `Refusing to run: unsupported characters in argument "${bad}".`
    opts.onLine?.(stderr, 'err')
    return { done: Promise.resolve({ code: null, stdout: '', stderr, timedOut: false }), kill() {} }
  }
  const spawnOpts = { cwd: opts.cwd, windowsHide: true, env: { ...process.env, ...launch.env, ...opts.env } }
  const proc = launch.shell
    ? spawn([quoteCommand(launch.command), ...launch.args].join(' '), { ...spawnOpts, shell: true })
    : spawn(launch.command, launch.args, spawnOpts)
  proc.stdin?.end()

  let stdout = ''
  let stderr = ''
  let timedOut = false
  const lines = (stream: 'out' | 'err') => {
    let partial = ''
    return {
      push(chunk: string) {
        if (stream === 'out') stdout += chunk
        else stderr += chunk
        if (!opts.onLine) return
        partial += chunk
        const parts = partial.split(/\r?\n/)
        partial = parts.pop() ?? ''
        for (const l of parts) opts.onLine(l, stream)
      },
      end() {
        if (partial && opts.onLine) opts.onLine(partial, stream)
        partial = ''
      }
    }
  }
  const out = lines('out')
  const err = lines('err')
  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')
  proc.stdout?.on('data', (c: string) => out.push(c))
  proc.stderr?.on('data', (c: string) => err.push(c))

  const kill = () => {
    if (proc.exitCode !== null || !proc.pid) return
    // proc may be cmd.exe or a node that starts children of its own.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    else proc.kill()
  }
  const done = new Promise<RunResult>((resolve) => {
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          kill()
        }, opts.timeoutMs)
      : undefined
    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      out.end()
      err.end()
      resolve({ code, stdout, stderr, timedOut })
    }
    // A failed launch may not be followed by close.
    proc.on('error', (e) => {
      err.push(`Failed to start ${command}: ${e.message}\n`)
      finish(null)
    })
    proc.on('close', (code) => finish(code))
  })
  return { done, kill }
}
