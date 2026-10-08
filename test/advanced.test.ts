// Per-session advanced options: cleaning the renderer's input, and the flags
// each agent gets. Claude flags checked against `claude --help` 2.1.292
// (--append-system-prompt-file is hidden but works); Pi's against pi 1.0.4 docs/cli.md.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isContextFile, readContextFile, writeContextFile } from '../src/main/context-files'
import { ClaudeAdapter, ClaudeTranslator, claudeArgs } from '../src/main/agents/claude'
import { cleanConfigChange, cleanSessionOptions, cleanStartOptions, removeTempFiles, sweepTempFiles, tempFile } from '../src/main/agents/options'
import { PiAdapter, piArgs, PI_PLAN_TOOLS } from '../src/main/agents/pi'
import type { AdapterSettings } from '../src/main/agents/types'
import type { AgentEvent } from '../src/shared/events'

const settings: AdapterSettings = {
  claudePath: 'claude',
  piPath: 'pi',
  permissionMode: 'acceptEdits',
  approvals: 'ask',
  piSubagentTools: [],
  piAutoCompaction: true
}
const auto = { model: '', effort: '', mode: 'auto' as const }

/** The part of an argument list after `flag`. */
const after = (args: string[], flag: string, n = 1) => {
  const i = args.indexOf(flag)
  return i < 0 ? undefined : args.slice(i + 1, i + 1 + n)
}

describe('cleanSessionOptions', () => {
  it('keeps well-formed Claude options', () => {
    const o = cleanSessionOptions('claude', {
      appendSystemPrompt: 'Prefer small diffs.\nAsk before deleting.',
      addDirs: ['C:\\Users\\A B\\shared', '  D:\\lib  '],
      mcpConfigs: ['C:\\mcp\\one.json'],
      strictMcp: true,
      maxBudgetUsd: '2.5',
      fallbackModel: 'sonnet,haiku',
      allowedTools: 'Bash(git *) Edit',
      bare: true
    })
    expect(o).toEqual({
      appendSystemPrompt: 'Prefer small diffs.\nAsk before deleting.',
      addDirs: ['C:\\Users\\A B\\shared', 'D:\\lib'],
      mcpConfigs: ['C:\\mcp\\one.json'],
      strictMcp: true,
      maxBudgetUsd: 2.5,
      fallbackModel: 'sonnet,haiku',
      allowedTools: 'Bash(git *) Edit',
      bare: true
    })
  })

  it('drops values the CLI would read as flags, wrong types and empties', () => {
    const o = cleanSessionOptions('claude', {
      addDirs: ['--dangerously-skip-permissions', 'ok', 5],
      agentsFile: '-x',
      maxBudgetUsd: -1,
      bare: 'yes',
      fallbackModel: '   ',
      appendSystemPrompt: ''
    })
    expect(o).toEqual({ addDirs: ['ok'] })
  })

  it('needs MCP configs for strict MCP', () => {
    expect(cleanSessionOptions('claude', { strictMcp: true })).toEqual({})
  })

  it('keeps only Pi fields for Pi', () => {
    expect(
      cleanSessionOptions('pi', { extensions: ['npm:pi-foo'], noMcp: true, tools: 'read,mcp__srv__*', bare: true, addDirs: ['x'] })
    ).toEqual({ extensions: ['npm:pi-foo'], noMcp: true, tools: 'read,mcp__srv__*' })
  })

  it('ignores junk', () => {
    expect(cleanSessionOptions('pi', null)).toEqual({})
    expect(cleanSessionOptions('claude', 'x')).toEqual({})
  })
})

describe('Claude advanced flags', () => {
  it('adds nothing by default', () => {
    expect(claudeArgs(settings, auto)).toEqual(claudeArgs(settings, auto, undefined, undefined, {}))
  })

  it('maps each option to its flag', () => {
    const args = claudeArgs(
      settings,
      auto,
      undefined,
      undefined,
      {
        appendSystemPrompt: 'x',
        addDirs: ['C:\\a b', 'D:\\c'],
        mcpConfigs: ['m.json'],
        strictMcp: true,
        agentsFile: 'agents.json',
        maxBudgetUsd: 5,
        fallbackModel: 'sonnet',
        allowedTools: 'Bash(git *) Edit',
        disallowedTools: 'WebFetch',
        bare: true
      },
      'C:\\Temp\\agent-deck\\x-append.md'
    )
    expect(after(args, '--append-system-prompt-file')).toEqual(['C:\\Temp\\agent-deck\\x-append.md'])
    expect(after(args, '--add-dir', 3)).toEqual(['C:\\a b', 'D:\\c', '--mcp-config'])
    expect(after(args, '--mcp-config', 2)).toEqual(['m.json', '--strict-mcp-config'])
    expect(after(args, '--agents')).toEqual(['agents.json'])
    expect(after(args, '--max-budget-usd')).toEqual(['5'])
    expect(after(args, '--fallback-model')).toEqual(['sonnet'])
    expect(after(args, '--allowedTools')).toEqual(['Bash(git *) Edit'])
    expect(after(args, '--disallowedTools')).toEqual(['WebFetch'])
    expect(args).toContain('--bare')
  })

  it('skips the appended prompt without its file', () => {
    expect(claudeArgs(settings, auto, undefined, undefined, { appendSystemPrompt: 'x' })).not.toContain('--append-system-prompt-file')
  })

  it('keeps the options and their temp file across a relaunch, and removes the file at the end', () => {
    class FakeClaude extends ClaudeAdapter {
      spawns: string[][] = []
      constructor() {
        super(() => {}, settings)
      }
      protected spawn(_c: string, args: string[]) {
        this.spawns.push(args)
      }
      protected write() {}
    }
    const c = new FakeClaude()
    c.start({ agent: 'claude', cwd: 'C:\\w', advanced: { appendSystemPrompt: 'Answer in French.', addDirs: ['D:\\x'] } })
    c.configure({ model: 'opus' })
    expect(c.spawns).toHaveLength(2)
    const file = after(c.spawns[0], '--append-system-prompt-file')![0]
    expect(after(c.spawns[1], '--append-system-prompt-file')).toEqual([file])
    expect(after(c.spawns[1], '--add-dir')).toEqual(['D:\\x'])
    expect(readFileSync(file, 'utf8')).toBe('Answer in French.')
    c.dispose()
    expect(existsSync(file)).toBe(false)
  })

  it('turns the budget stop into a notice, not an error', () => {
    const events: AgentEvent[] = new ClaudeTranslator().handle({
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      errors: ['Reached maximum budget ($0.01)'],
      total_cost_usd: 0.0123
    })
    expect(events.find((e) => e.kind === 'error')).toBeUndefined()
    expect(events).toContainEqual({ kind: 'notice', text: 'Budget of $0.01 reached. Start a new session or raise the cap under Advanced.' })
    expect(events.at(-1)).toEqual({ kind: 'turn-end' })
  })
})

describe('Pi advanced flags', () => {
  const o = {
    appendSystemPrompt: 'x',
    extensions: ['npm:pi-foo', 'git:github.com/u/r'],
    noContextFiles: true,
    noMcp: true,
    tools: 'read,bash,mcp__docs__*',
    excludeTools: 'mcp__fs__write*'
  }

  it('maps each option in auto mode', () => {
    expect(piArgs('auto', o, 'C:\\T\\a.md')).toEqual([
      '--mode', 'rpc',
      '--tools', 'read,bash,mcp__docs__*',
      '--no-mcp',
      '--exclude-tools', 'mcp__fs__write*',
      '-e', 'npm:pi-foo',
      '-e', 'git:github.com/u/r',
      '-nc',
      '--append-system-prompt', 'C:\\T\\a.md'
    ])
  })

  it('never widens plan mode: its tools and --no-mcp stay, excludes still apply', () => {
    const args = piArgs('plan', o, 'C:\\T\\a.md')
    expect(after(args, '--tools')).toEqual([PI_PLAN_TOOLS])
    expect(args.filter((a) => a === '--tools')).toHaveLength(1)
    expect(args.filter((a) => a === '--no-mcp')).toHaveLength(1)
    expect(after(args, '--exclude-tools')).toEqual(['mcp__fs__write*'])
  })

  it('keeps options across the plan-mode relaunch', () => {
    class FakePi extends PiAdapter {
      spawns: string[][] = []
      constructor() {
        super(() => {}, settings)
      }
      protected spawn(_c: string, args: string[]) {
        this.spawns.push(args)
      }
      protected write() {}
    }
    const p = new FakePi()
    p.start({ agent: 'pi', cwd: 'C:\\w', advanced: { extensions: ['npm:pi-foo'] } })
    expect(p.spawns[0]).toEqual(['--mode', 'rpc', '-e', 'npm:pi-foo'])
    p.dispose()
  })
})

describe('Pi instruction files', () => {
  it('maps each kind to its fixed path, writes editable ones, refuses SYSTEM.md', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-ctx-'))
    const cwd = join(root, 'my project')
    const agentDir = join(root, 'agent')
    try {
      const empty = await readContextFile(cwd, 'project-append', agentDir)
      expect(empty).toEqual({ which: 'project-append', path: join(cwd, '.pi', 'APPEND_SYSTEM.md'), exists: false, text: '', readOnly: false })
      await writeContextFile(cwd, 'project-append', 'Be brief.', agentDir)
      expect(readFileSync(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'utf8')).toBe('Be brief.')
      await writeContextFile(cwd, 'global-agents', '# Global', agentDir)
      expect((await readContextFile(cwd, 'global-agents', agentDir)).text).toBe('# Global')
      expect((await readContextFile(cwd, 'project-agents', agentDir)).path).toBe(join(cwd, 'AGENTS.md'))
      await expect(writeContextFile(cwd, 'global-system', 'x', agentDir)).rejects.toThrow()
      expect(isContextFile('project-agents')).toBe(true)
      expect(isContextFile('../../etc/passwd')).toBe(false)
      expect(isContextFile('constructor')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('tempFile', () => {
  it('writes and removes', () => {
    const f = tempFile('t.md', 'hello')
    expect(readFileSync(f.path, 'utf8')).toBe('hello')
    f.remove()
    expect(existsSync(f.path)).toBe(false)
  })

  it('writes into a private folder for this run', () => {
    const f = tempFile('t.md', 'secret')
    const dir = dirname(f.path)
    expect(basename(dir)).toMatch(new RegExp(`^agent-deck-${process.pid}-`))
    expect(dirname(tempFile('u.md', 'x').path)).toBe(dir)
    // Owner-only; Windows has no POSIX modes (the per-user temp folder covers it).
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(f.path).mode & 0o777).toBe(0o600)
    }
    removeTempFiles()
    expect(existsSync(dir)).toBe(false)
    // The next file makes a fresh folder.
    const g = tempFile('t.md', 'again')
    expect(readFileSync(g.path, 'utf8')).toBe('again')
    removeTempFiles()
  })

  it('sweeps folders whose run has ended, and day-old files from the old layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-sweep-'))
    try {
      const dirs = ['agent-deck-111-aaa', 'agent-deck-222-bbb', `agent-deck-${process.pid}-own`, 'agent-deck-settings-x', 'unrelated']
      for (const d of dirs) mkdirSync(join(root, d))
      const legacy = join(root, 'agent-deck')
      mkdirSync(legacy)
      writeFileSync(join(legacy, 'old-append.md'), 'x')
      writeFileSync(join(legacy, 'new-append.md'), 'y')
      const now = Date.now()
      const twoDaysAgo = (now - 2 * 24 * 60 * 60 * 1000) / 1000
      utimesSync(join(legacy, 'old-append.md'), twoDaysAgo, twoDaysAgo)

      // 111 has exited; 222 is still running.
      sweepTempFiles(root, (pid) => pid === 222, now)
      expect(readdirSync(root).sort()).toEqual(['agent-deck', 'agent-deck-222-bbb', `agent-deck-${process.pid}-own`, 'agent-deck-settings-x', 'unrelated'].sort())
      expect(readdirSync(legacy)).toEqual(['new-append.md'])

      // Once the old folder is empty it goes too.
      rmSync(join(legacy, 'new-append.md'))
      sweepTempFiles(root, () => true, now)
      expect(existsSync(legacy)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Start requests from the renderer', () => {
  const base = { agent: 'claude', cwd: 'D:\\proj' }

  it('keeps a well-formed request', () => {
    const resume = { id: '6f1c2b9e-0d3a-4c55-9a77-3b1f0e2d4c88', path: 'C:\\Users\\a\\.claude\\projects\\D--proj\\6f1c.jsonl' }
    expect(cleanStartOptions({ ...base, model: 'opus', effort: 'high', mode: 'plan', resume, advanced: { bare: true } })).toEqual({
      ...base,
      model: 'opus',
      effort: 'high',
      mode: 'plan',
      resume,
      advanced: { bare: true }
    })
  })

  it('defaults the mode and leaves out empty choices', () => {
    expect(cleanStartOptions({ ...base, model: '', effort: '', mode: 'yolo' })).toEqual({ ...base, mode: 'auto', advanced: {} })
  })

  it('refuses an unknown agent or a missing folder', () => {
    expect(cleanStartOptions({ ...base, agent: 'bash' })).toEqual({ error: 'Unknown agent.' })
    expect(cleanStartOptions({ agent: 'pi' })).toEqual({ error: 'Choose a project folder first.' })
    expect(cleanStartOptions(null)).toEqual({ error: 'Unknown agent.' })
  })

  it('never lets a model or effort become a flag', () => {
    const opts = cleanStartOptions({ ...base, model: '--dangerously-skip-permissions', effort: '-x' })
    expect(opts).toEqual({ ...base, mode: 'auto', advanced: {} })
  })

  it('refuses a resume id that could be read as a flag, or a malformed resume', () => {
    expect(cleanStartOptions({ ...base, resume: { id: '--fork-session', path: 'x.jsonl' } })).toEqual({ error: 'That saved session is not valid.' })
    expect(cleanStartOptions({ ...base, resume: { id: 'abc' } })).toEqual({ error: 'That saved session is not valid.' })
    // Pi's session header may have no id; the path is what it switches to.
    expect(cleanStartOptions({ ...base, agent: 'pi', resume: { id: '', path: 'p.jsonl' } })).toMatchObject({ resume: { id: '', path: 'p.jsonl' } })
  })

  it('checks a live model, effort or mode change the same way', () => {
    expect(cleanConfigChange({ model: 'openrouter/openrouter/free', effort: '', mode: 'plan' })).toEqual({
      model: 'openrouter/openrouter/free',
      effort: '',
      mode: 'plan'
    })
    expect(cleanConfigChange({ model: '--settings', mode: 'root', extra: 1 })).toEqual({})
  })
})
