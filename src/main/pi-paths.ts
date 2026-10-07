// Where Pi keeps its files (see pi-coding-agent docs/configuration.md).
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Pi's agent dir: settings, packages, sessions, mcp.json. PI_CODING_AGENT_DIR overrides it. */
export function piAgentDir(env: Record<string, string | undefined> = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
}

/** A project's own Pi folder (settings, mcp.json, APPEND_SYSTEM.md); used only once the project is trusted. */
export function piProjectDir(cwd: string): string {
  return join(cwd, '.pi')
}
