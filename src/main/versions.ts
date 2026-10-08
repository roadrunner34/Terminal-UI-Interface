// Agent Deck drives each CLI through flags and control messages that change
// between releases, a few of them undocumented (--resume-session-at,
// --append-system-prompt-file, Claude's control subtypes). When a launch
// fails after a CLI update, the installed version is the first thing to know,
// so it is checked against the versions this build was tested with.
import { homedir } from 'node:os'
import type { CliVersion } from '@shared/api'
import type { AgentId } from '@shared/events'
import { run } from './runner'

/** The oldest version tested; later releases of the same major version are expected to work. */
export const TESTED_VERSIONS: Record<AgentId, { name: string; min: string; update: string }> = {
  claude: { name: 'Claude Code', min: '2.1.292', update: 'claude update' },
  pi: { name: 'Pi', min: '1.0.4', update: 'pi update' }
}

const PROBE_TIMEOUT_MS = 15_000
const CACHE_MS = 10 * 60_000

/** The first x.y.z in a `--version` line ("2.1.292 (Claude Code)" → "2.1.292", "v1.0.4" → "1.0.4"). */
export function parseVersion(text: string): string | null {
  // Not \b: there is no word boundary between a "v" prefix and the digits.
  return /(?<![\d.])\d+\.\d+\.\d+/.exec(text)?.[0] ?? null
}

/** Compares two x.y.z versions numerically: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/** How a version compares with what was tested, with a sentence when it matters. */
export function checkVersion(agent: AgentId, command: string, version: string | null): CliVersion {
  const t = TESTED_VERSIONS[agent]
  const base = { agent, command, tested: t.min }
  if (!version) return { ...base, status: 'unknown', message: `Couldn't tell which version of ${t.name} \`${command}\` is.` }
  if (compareVersions(version, t.min) < 0)
    return {
      ...base,
      version,
      status: 'old',
      message: `${t.name} ${version} is older than ${t.min}, the oldest version Agent Deck is tested with, so some features may fail. Update it with \`${t.update}\`.`
    }
  const major = t.min.split('.')[0]
  if (version.split('.')[0] !== major)
    return {
      ...base,
      version,
      status: 'new',
      message: `${t.name} ${version} is newer than the versions Agent Deck is tested with (${major}.x). If sessions fail to start, look for an Agent Deck update.`
    }
  return { ...base, version, status: 'ok' }
}

const cache = new Map<string, { at: number; result: Promise<CliVersion> }>()

/** Runs `<command> --version` once per few minutes per command; `fresh` skips the cache. */
export function probeVersion(agent: AgentId, command: string, fresh = false): Promise<CliVersion> {
  const key = `${agent}\0${command}`
  const hit = cache.get(key)
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.result
  const result = run(command, ['--version'], { cwd: homedir(), timeoutMs: PROBE_TIMEOUT_MS }).done.then((r) => {
    // cmd.exe answers a missing command with exit code 1 and "is not recognized".
    if (r.code !== 0 && !parseVersion(r.stdout))
      return {
        agent,
        command,
        tested: TESTED_VERSIONS[agent].min,
        status: 'missing' as const,
        message: `Couldn't run \`${command}\`. Check the command in Settings.`
      }
    return checkVersion(agent, command, parseVersion(r.stdout) ?? parseVersion(r.stderr))
  })
  cache.set(key, { at: Date.now(), result })
  return result
}
