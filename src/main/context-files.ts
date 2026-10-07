// Pi's instruction files, edited from the setup form (see pi-coding-agent
// docs/configuration.md). The renderer names a file by kind, never by path.
import type { ContextFileInfo, PiContextFile } from '@shared/api'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { piAgentDir, piProjectDir } from './pi-paths'

export const CONTEXT_FILES: Record<PiContextFile, { where: (cwd: string, agentDir: string) => string; readOnly: boolean }> = {
  // Read from the folder and its parents, trusted or not.
  'project-agents': { where: (cwd) => join(cwd, 'AGENTS.md'), readOnly: false },
  // Project .pi/ files apply only once the project is trusted.
  'project-append': { where: (cwd) => join(piProjectDir(cwd), 'APPEND_SYSTEM.md'), readOnly: false },
  'global-agents': { where: (_, agent) => join(agent, 'AGENTS.md'), readOnly: false },
  // SYSTEM.md replaces Pi's whole prompt: shown, not edited here.
  'project-system': { where: (cwd) => join(piProjectDir(cwd), 'SYSTEM.md'), readOnly: true },
  'global-system': { where: (_, agent) => join(agent, 'SYSTEM.md'), readOnly: true }
}

export function isContextFile(v: unknown): v is PiContextFile {
  return typeof v === 'string' && Object.hasOwn(CONTEXT_FILES, v)
}

const MAX_BYTES = 200_000

export async function readContextFile(cwd: string, which: PiContextFile, agentDir = piAgentDir()): Promise<ContextFileInfo> {
  const spec = CONTEXT_FILES[which]
  const path = spec.where(cwd, agentDir)
  const exists = existsSync(path)
  const text = exists ? (await readFile(path, 'utf8')).slice(0, MAX_BYTES) : ''
  return { which, path, exists, text, readOnly: spec.readOnly }
}

export async function writeContextFile(cwd: string, which: PiContextFile, text: string, agentDir = piAgentDir()): Promise<ContextFileInfo> {
  const spec = CONTEXT_FILES[which]
  if (spec.readOnly) throw new Error(`${which} can't be edited here.`)
  if (typeof text !== 'string' || text.length > MAX_BYTES) throw new Error('That text is too long.')
  const path = spec.where(cwd, agentDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  return { which, path, exists: true, text, readOnly: false }
}
