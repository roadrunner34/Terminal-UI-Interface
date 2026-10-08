import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentConfig, ImageAttachment, McpAction, PromptAnswer, SendOptions, StartOptions } from '@shared/events'
import { groupSpawnOptions, killTree } from '../kill'
import { quoteCommand, resolveLaunch, SAFE_ARG } from '../resolve'
import { JsonlSplitter } from './jsonl'
import type { AgentAdapter, Emit, Translator } from './types'

/** Shared child-process plumbing: spawn, JSONL in/out, exit handling. */
export abstract class ProcessAdapter implements AgentAdapter {
  protected proc: ChildProcessWithoutNullStreams | null = null
  private stderrTail = ''

  constructor(
    protected emit: Emit,
    protected translator: Translator
  ) {}

  abstract start(opts: StartOptions): void
  abstract send(text: string, images?: ImageAttachment[], opts?: SendOptions): void
  abstract abort(): void
  abstract compact(): void
  abstract clearQueue(): void
  abstract contextUsage(): void
  abstract stopTask(taskId: string): void
  abstract shell(command: string): void
  abstract rename(title: string): void
  abstract exportSession(path: string): void
  abstract fork(entryId: string): void
  abstract rewind(entryId: string): void
  abstract configure(config: Partial<AgentConfig>): void
  abstract approvePlan(): void
  abstract answerPrompt(id: string, answer: PromptAnswer): void
  abstract mcp(action: McpAction, name?: string): void

  protected spawn(command: string, args: string[], cwd: string, env: Record<string, string> = {}): void {
    // Only the process: a relaunch keeps everything else the adapter tracks.
    this.kill()
    // Re-resolved on every spawn, so a relaunch picks up a CLI update.
    const launch = resolveLaunch(command, args)
    // When a .cmd can't be unwrapped it needs cmd.exe, which can't safely
    // escape arbitrary text: build the command line ourselves and refuse
    // arguments with shell metacharacters.
    const bad = launch.shell ? args.find((a) => !SAFE_ARG.test(a)) : undefined
    if (bad !== undefined) {
      this.emit({ kind: 'error', message: `Refusing to start: unsupported characters in argument "${bad}".` })
      this.emit({ kind: 'exit', code: null })
      return
    }
    const opts = { cwd, windowsHide: true, env: { ...process.env, ...launch.env, ...env }, ...groupSpawnOptions() }
    const proc = launch.shell
      ? spawn([quoteCommand(launch.command), ...launch.args].join(' '), { ...opts, shell: true })
      : spawn(launch.command, launch.args, opts)
    this.proc = proc
    this.stderrTail = ''

    const splitter = new JsonlSplitter(
      (rec) => this.onRecord(rec),
      (line) => console.warn(`[agent] non-JSON line: ${line.slice(0, 200)}`)
    )
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (c) => splitter.push(c))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (c: string) => {
      this.stderrTail = (this.stderrTail + c).slice(-2000)
    })
    proc.on('error', (err) => this.emit({ kind: 'error', message: `Failed to start ${command}: ${err.message}` }))
    proc.on('close', (code) => {
      splitter.end()
      if (this.proc !== proc) return
      this.proc = null
      if (code && this.stderrTail.trim()) this.emit({ kind: 'error', message: this.stderrTail.trim() })
      this.emit({ kind: 'exit', code })
    })
  }

  protected onRecord(rec: any): void {
    for (const e of this.translator.handle(rec)) this.emit(e)
  }

  protected write(obj: unknown): void {
    if (!this.proc) {
      this.emit({ kind: 'error', message: 'Agent is not running. Start a session first.' })
      return
    }
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  dispose(): void {
    this.kill()
  }

  protected kill(): void {
    const proc = this.proc
    this.proc = null
    if (!proc) return
    proc.stdin.end()
    // proc may be cmd.exe or a node that starts its own children: end them all.
    killTree(proc)
  }
}
