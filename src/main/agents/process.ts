import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentConfig, ImageAttachment, PromptAnswer, StartOptions } from '@shared/events'
import { JsonlSplitter } from './jsonl'
import type { AgentAdapter, Emit, Translator } from './types'

/** Flag values we pass on a command line: ids, paths, model names. */
const SAFE_ARG = /^[\w./:@=+,-]+$/

function quoteCommand(command: string): string {
  return /\s/.test(command) && !command.startsWith('"') ? `"${command}"` : command
}

/** Shared child-process plumbing: spawn, JSONL in/out, exit handling. */
export abstract class ProcessAdapter implements AgentAdapter {
  protected proc: ChildProcessWithoutNullStreams | null = null
  private stderrTail = ''

  constructor(
    protected emit: Emit,
    protected translator: Translator
  ) {}

  abstract start(opts: StartOptions): void
  abstract send(text: string, images?: ImageAttachment[]): void
  abstract abort(): void
  abstract configure(config: Partial<AgentConfig>): void
  abstract approvePlan(): void
  abstract answerPrompt(id: string, answer: PromptAnswer): void

  protected spawn(command: string, args: string[], cwd: string): void {
    // Only the process: a relaunch keeps everything else the adapter tracks.
    this.kill()
    // npm-installed CLIs on Windows are .cmd shims, which need a shell to run.
    // cmd.exe can't safely escape arbitrary text, so build the command line
    // ourselves and refuse arguments with shell metacharacters.
    const shell = process.platform === 'win32'
    const bad = shell ? args.find((a) => !SAFE_ARG.test(a)) : undefined
    if (bad !== undefined) {
      this.emit({ kind: 'error', message: `Refusing to start: unsupported characters in argument "${bad}".` })
      this.emit({ kind: 'exit', code: null })
      return
    }
    const opts = { cwd, windowsHide: true, env: process.env }
    const proc = shell
      ? spawn([quoteCommand(command), ...args].join(' '), { ...opts, shell: true })
      : spawn(command, args, opts)
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
    if (process.platform === 'win32' && proc.pid) {
      // With shell: true, proc is cmd.exe; kill the whole tree.
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    } else {
      proc.kill()
    }
  }
}
