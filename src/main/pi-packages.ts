// Pi packages: what's installed (read from Pi's own files, not `pi list`,
// which hides project packages until the project is trusted), the closed set
// of `pi` commands that change them, and npm search for discovery.
//
// Layout (pi 1.0.4, docs/packages.md and a live run):
//   user:    <agentDir>/settings.json → packages[], npm installs in <agentDir>/npm/node_modules
//   project: <cwd>/.pi/settings.json → packages[], npm installs in <cwd>/.pi/npm/node_modules
// A packages[] entry is a source string or { source, extensions, skills, prompts, themes }.
import type { PiPackage, PiPackageOp, PiPackageSearchResult } from '@shared/api'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { piAgentDir, piProjectDir } from './pi-paths'

/** Sources the package runner accepts: npm (optionally scoped and versioned), git, https. */
export const PI_SOURCE = /^(npm:(@[\w.-]+\/)?[\w.-]+(@[\w.^~-]+)?|git:[\w.@:/-]+|https:\/\/[\w./-]+)$/

/** Targets that make `pi update` update Pi itself. Never built. */
const SELF = new Set(['pi', 'self', '--self', '--all', 'npm:pi', 'npm:@earendil-works/pi-coding-agent'])

/** The `pi` arguments for an operation, or an error to show. */
export function piPackageArgs(op: PiPackageOp): { args: string[] } | { error: string } {
  if (op.op === 'update-all') return { args: ['update', '--extensions'] }
  const source = typeof op.source === 'string' ? op.source.trim() : ''
  if (SELF.has(source.toLowerCase())) return { error: 'Update Pi itself from a terminal with `pi update`.' }
  if (!PI_SOURCE.test(source)) return { error: 'Use an npm or git source, such as npm:pi-foo or git:github.com/user/repo.' }
  const local = op.local === true
  switch (op.op) {
    case 'install':
      return { args: ['install', source, ...(local ? ['-l'] : [])] }
    // Pi only changes a project's package config with project trust; the user
    // asked for this one change, so trust it for this command only.
    case 'remove':
      return { args: ['remove', source, ...(local ? ['-l', '--approve'] : [])] }
    // `update` has no -l; it finds project packages only with trust.
    case 'update':
      return { args: ['update', source, ...(local ? ['--approve'] : [])] }
    default:
      return { error: 'Unknown package operation.' }
  }
}

/** "npm:@scope/name@1.2.3" → "@scope/name"; null for other kinds. */
export function npmName(source: string): string | null {
  const m = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@.*)?$/.exec(source)
  return m ? m[1] : null
}

async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

const RESOURCES = ['extensions', 'skills', 'prompts', 'themes'] as const

async function describe(entry: unknown, scope: 'user' | 'project', npmRoot: string): Promise<PiPackage | null> {
  const source = typeof entry === 'string' ? entry : typeof (entry as any)?.source === 'string' ? (entry as any).source : null
  if (!source) return null
  const pkg: PiPackage = {
    source,
    scope,
    kind: source.startsWith('npm:') ? 'npm' : source.startsWith('git:') || source.startsWith('https:') ? 'git' : 'local',
    filtered: typeof entry === 'object',
    installed: false
  }
  const name = npmName(source)
  if (!name) return pkg
  pkg.name = name
  const json = await readJson(join(npmRoot, ...name.split('/'), 'package.json'))
  if (!json) return pkg
  pkg.installed = true
  if (typeof json.version === 'string') pkg.version = json.version
  if (typeof json.description === 'string') pkg.description = json.description.slice(0, 300)
  if (json.pi && typeof json.pi === 'object') {
    const counts: Partial<Record<(typeof RESOURCES)[number], number>> = {}
    for (const r of RESOURCES) if (Array.isArray(json.pi[r]) && json.pi[r].length) counts[r] = json.pi[r].length
    pkg.resources = counts
  }
  return pkg
}

async function listScope(settingsFile: string, scope: 'user' | 'project', npmRoot: string): Promise<PiPackage[]> {
  const settings = await readJson(settingsFile)
  const entries: unknown[] = Array.isArray(settings?.packages) ? settings.packages : []
  return (await Promise.all(entries.map((e) => describe(e, scope, npmRoot)))).filter((p): p is PiPackage => !!p)
}

/** User packages, plus the project's when `cwd` is given. */
export async function listPiPackages(cwd?: string, agentDir = piAgentDir()): Promise<PiPackage[]> {
  const user = await listScope(join(agentDir, 'settings.json'), 'user', join(agentDir, 'npm', 'node_modules'))
  if (!cwd) return user
  const dir = piProjectDir(cwd)
  return [...user, ...(await listScope(join(dir, 'settings.json'), 'project', join(dir, 'npm', 'node_modules')))]
}

/** Removes terminal colour codes from a line of `pi` output. */
export function plainLine(line: string): string {
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

/** npm packages tagged `pi-package` (the list behind pi.dev/packages), optionally narrowed by text. */
export async function searchPiPackages(
  query: string,
  fetchFn: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }> = fetch
): Promise<PiPackageSearchResult[]> {
  const text = ['keywords:pi-package', query.trim().slice(0, 100)].filter(Boolean).join(' ')
  const res = await fetchFn(`https://registry.npmjs.org/-/v1/search?size=30&text=${encodeURIComponent(text)}`)
  if (!res.ok) throw new Error(`npm search failed (${res.status}).`)
  const data = await res.json()
  return (Array.isArray(data?.objects) ? data.objects : [])
    .filter((o: any) => typeof o?.package?.name === 'string')
    .map((o: any) => ({
      name: String(o.package.name),
      version: String(o.package.version ?? ''),
      description: String(o.package.description ?? '').slice(0, 300),
      weeklyDownloads: typeof o.downloads?.weekly === 'number' ? o.downloads.weekly : undefined
    }))
}
