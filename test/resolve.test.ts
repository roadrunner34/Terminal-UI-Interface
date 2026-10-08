import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveCommand, resolveLaunch } from '../src/main/resolve'

let root: string

function file(rel: string, text = ''): string {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

const PATHEXT = '.COM;.EXE;.BAT;.CMD'
const env = (...dirs: string[]) => ({ Path: dirs.map((d) => join(root, d)).join(';'), PATHEXT })
const NO_CWD = { NoDefaultCurrentDirectoryInExePath: '1' }

/** A Pi 1.0.4 managed install under `<root>/agent`, as `pi install` lays it out. */
function managedPi(opts: { version?: string; schemaVersion?: number; bin?: string } = {}): string {
  const version = opts.version ?? '1.0.4'
  file('agent/bin/pi', '#!/bin/sh\n')
  const cmd = file('agent/bin/pi.cmd', '@ECHO off\r\nnode "%~dp0pi-launcher.js" %*\r\n')
  file(
    'agent/install/managed-install.json',
    JSON.stringify({ kind: 'pi-managed-install', schemaVersion: opts.schemaVersion ?? 1, layout: 'releases-v1' })
  )
  file('agent/install/current-version', `${version}\n`)
  const pkg = 'agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent'
  file(`${pkg}/package.json`, JSON.stringify({ bin: { pi: opts.bin ?? 'dist/bundle/cli.js' } }))
  file(`${pkg}/dist/bundle/cli.js`)
  return cmd
}

const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*'
].join('\r\n')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-deck-resolve-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveCommand', () => {
  it('never returns a file without an extension', () => {
    file('a/pi', '#!/bin/sh\n')
    expect(resolveCommand('pi', env('a'), 'win32')).toBeNull()
    const cmd = file('a/pi.cmd')
    expect(resolveCommand('pi', env('a'), 'win32')).toBe(cmd)
  })

  it('walks PATH in order, then PATHEXT in order', () => {
    file('a/tool.cmd')
    const exe = file('b/tool.exe')
    file('b/tool.cmd')
    expect(resolveCommand('tool', env('missing', 'b', 'a'), 'win32')).toBe(exe)
    expect(resolveCommand('tool', env('a', 'b'), 'win32')).toBe(join(root, 'a/tool.cmd'))
  })

  it('accepts a path, with or without the extension', () => {
    const exe = file('dir with space/claude.exe')
    expect(resolveCommand(exe, env(), 'win32')).toBe(exe)
    expect(resolveCommand(exe.slice(0, -4), env(), 'win32')).toBe(exe)
  })

  it('does nothing off Windows', () => {
    file('a/tool.exe')
    expect(resolveCommand('tool', env('a'), 'linux')).toBeNull()
  })
})

describe('resolveLaunch', () => {
  it('runs an .exe without the shell', () => {
    const exe = file('bin/claude.exe')
    expect(resolveLaunch('claude', ['-p', 'a b'], env('bin'), 'win32')).toEqual({
      command: exe,
      args: ['-p', 'a b'],
      env: {},
      shell: false
    })
  })

  it('unwraps the Pi managed launcher to node + the release cli.js', () => {
    managedPi()
    const node = file('node/node.exe')
    const launch = resolveLaunch('pi', ['--mode', 'rpc'], env('agent/bin', 'node'), 'win32')
    const cli = join(root, 'agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')
    expect(launch).toEqual({
      command: node,
      args: [cli, '--mode', 'rpc'],
      env: { PI_MANAGED_INSTALL_ROOT: join(root, 'agent/install') },
      shell: false
    })
  })

  it.each([
    ['an unsafe current-version', { version: '..' }],
    ['a missing release', { version: '9.9.9' }],
    ['an unknown manifest schema', { schemaVersion: 2 }],
    ['a bin outside the package', { bin: '../../../../../evil.js' }]
  ])('falls back to the shell for %s', (_, opts) => {
    const cmd = managedPi(opts)
    file('node/node.exe')
    expect(resolveLaunch('pi', ['--mode', 'rpc'], env('agent/bin', 'node'), 'win32')).toEqual({
      command: cmd,
      args: ['--mode', 'rpc'],
      env: NO_CWD,
      shell: true
    })
  })

  it('unwraps an npm cmd-shim', () => {
    const cmd = file('npm/pi.cmd', NPM_SHIM)
    file('npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')
    const node = file('node/node.exe')
    const launch = resolveLaunch('pi', ['--mode', 'rpc'], env('npm', 'node'), 'win32')
    expect(launch.shell).toBe(false)
    expect(launch.command).toBe(node)
    expect(launch.args).toEqual([
      join(dirname(cmd), 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
      '--mode',
      'rpc'
    ])
  })

  it('keeps the shell when node is not on PATH', () => {
    const cmd = managedPi()
    expect(resolveLaunch('pi', [], env('agent/bin'), 'win32')).toMatchObject({ command: cmd, shell: true })
  })

  it('keeps the shell for an unknown .cmd or an unresolved command', () => {
    const cmd = file('a/thing.cmd', '@echo hi\r\n')
    file('node/node.exe')
    expect(resolveLaunch('thing', [], env('a', 'node'), 'win32')).toMatchObject({ command: cmd, shell: true })
    expect(resolveLaunch('nope', ['x'], env('a'), 'win32')).toEqual({ command: 'nope', args: ['x'], env: NO_CWD, shell: true })
  })

  it('keeps cmd.exe out of the project folder only when it launches through the shell', () => {
    // cmd.exe runs in the project folder; a planted claude.exe or node.exe there must not win over PATH.
    expect(resolveLaunch('nope', [], env(), 'win32').env).toEqual(NO_CWD)
    file('bin/claude.exe')
    expect(resolveLaunch('claude', [], env('bin'), 'win32').env).toEqual({})
  })

  it('passes commands through unchanged off Windows', () => {
    expect(resolveLaunch('pi', ['--mode', 'rpc'], env(), 'linux')).toEqual({
      command: 'pi',
      args: ['--mode', 'rpc'],
      env: {},
      shell: false
    })
  })
})
