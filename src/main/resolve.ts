// How to launch an agent CLI on Windows without cmd.exe.
//
// cmd.exe can't safely escape arbitrary text, so a shell launch limits what
// arguments we can pass (see SAFE_ARG in agents/process.ts). We avoid the
// shell when the command resolves to:
//   - an .exe/.com, which Node quotes properly for CreateProcess;
//   - Pi's managed launcher (~/.pi/agent/bin/pi.cmd), unwrapped to
//     `node <release>/…/cli.js`, following pi-launcher.js;
//   - an npm .cmd shim, unwrapped to `node <package>/<bin>.js`.
// Anything else (.bat, unknown shims, nothing found) keeps the shell.
// Electron's Node refuses .cmd/.bat without a shell (CVE-2024-27980).
//
// Nothing is cached: `pi update` switches the managed release, and the next
// launch should run the new one.

import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

/** What a shell launch accepts as an argument: ids, paths without spaces, model names. */
export const SAFE_ARG = /^[\w./:@=+,-]+$/

/** Quotes a command path with spaces for a cmd.exe command line. */
export function quoteCommand(command: string): string {
  return /\s/.test(command) && !command.startsWith('"') ? `"${command}"` : command
}

export interface Launch {
  command: string
  args: string[]
  /** Extra environment for the child, merged over process.env. */
  env: Record<string, string>
  /** True when it must go through cmd.exe, so arguments must pass SAFE_ARG. */
  shell: boolean
}

type Env = Record<string, string | undefined>

function envVar(env: Env, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Finds a command the way cmd.exe does: as given if it is a path, otherwise
 * each PATH entry × each PATHEXT extension. Files without an extension are
 * never returned: ~/.pi/agent/bin holds both `pi` (an sh script) and `pi.cmd`.
 * Returns null when nothing matches, or off Windows.
 */
export function resolveCommand(cmd: string, env: Env = process.env, platform = process.platform): string | null {
  if (platform !== 'win32' || !cmd) return null
  const exts = (envVar(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  const candidates = (base: string): string[] =>
    exts.includes(extname(base).toLowerCase()) ? [base] : exts.map((e) => base + e)

  if (isAbsolute(cmd) || /[\\/]/.test(cmd)) {
    return candidates(resolve(cmd)).find(isFile) ?? null
  }
  for (const dir of (envVar(env, 'PATH') || '').split(';')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1')
    if (!d) continue
    const hit = candidates(join(d, cmd)).find(isFile)
    if (hit) return hit
  }
  return null
}

const PI_PACKAGE = ['@earendil-works', 'pi-coding-agent']
const PI_VERSION = /^[0-9A-Za-z._+-]+$/

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Resolves `target` and checks it stays inside `root`. */
function inside(root: string, target: string): string | null {
  const full = resolve(root, target)
  const rel = relative(root, full)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : null
}

/**
 * Pi's managed install (`pi-managed-install`, schema 1, `releases-v1`):
 * `<agentDir>/bin/pi.cmd` runs pi-launcher.js, which reads
 * `install/current-version` and starts the release's `bin.pi` with
 * PI_MANAGED_INSTALL_ROOT set. Returns the script and env, or null if the
 * layout doesn't match exactly.
 */
export function piManagedEntry(cmdPath: string): { script: string; env: Record<string, string> } | null {
  if (basename(dirname(cmdPath)).toLowerCase() !== 'bin') return null
  const installRoot = join(dirname(dirname(cmdPath)), 'install')
  const manifest = readJson(join(installRoot, 'managed-install.json'))
  if (manifest?.kind !== 'pi-managed-install' || manifest.schemaVersion !== 1 || manifest.layout !== 'releases-v1') {
    return null
  }
  let version: string
  try {
    version = readFileSync(join(installRoot, 'current-version'), 'utf8').trim()
  } catch {
    return null
  }
  if (!PI_VERSION.test(version) || version === '.' || version === '..') return null
  const pkgDir = join(installRoot, 'releases', version, 'node_modules', ...PI_PACKAGE)
  const pkg = readJson(join(pkgDir, 'package.json'))
  const bin = typeof pkg?.bin === 'string' ? pkg.bin : pkg?.bin?.pi
  if (typeof bin !== 'string') return null
  const script = inside(pkgDir, bin)
  if (!script || !isFile(script)) return null
  return { script, env: { PI_MANAGED_INSTALL_ROOT: installRoot } }
}

/**
 * An npm cmd-shim ends with `"%_prog%" "%dp0%\node_modules\…\cli.js" %*`.
 * Returns that script if it exists inside the shim's folder.
 */
export function npmShimEntry(cmdPath: string): string | null {
  let text: string
  try {
    text = readFileSync(cmdPath, 'utf8')
  } catch {
    return null
  }
  const m = /"%dp0%\\([^"%]+\.[cm]?js)"\s+%\*/i.exec(text)
  if (!m) return null
  const script = inside(dirname(cmdPath), m[1])
  return script && isFile(script) ? script : null
}

/** How to start `cmd args` on this platform. */
export function resolveLaunch(
  cmd: string,
  args: string[],
  env: Env = process.env,
  platform = process.platform
): Launch {
  const viaShell: Launch = { command: cmd, args, env: {}, shell: platform === 'win32' }
  if (platform !== 'win32') return viaShell
  const found = resolveCommand(cmd, env, platform)
  if (!found) return viaShell
  const ext = extname(found).toLowerCase()
  if (ext === '.exe' || ext === '.com') return { command: found, args, env: {}, shell: false }
  if (ext !== '.cmd') return { ...viaShell, command: found }

  const managed = piManagedEntry(found)
  const script = managed?.script ?? npmShimEntry(found)
  const node = script ? resolveCommand('node', env, platform) : null
  if (!script || !node || extname(node).toLowerCase() !== '.exe') return { ...viaShell, command: found }
  return { command: node, args: [script, ...args], env: managed?.env ?? {}, shell: false }
}
