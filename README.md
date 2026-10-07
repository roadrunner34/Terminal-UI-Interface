# Agent Deck

A desktop UI for local coding agents (Claude Code and Pi). Chat with the agent on the left (80%), watch its subagents on the right (20%), and keep an eye on tokens, context and cost in the stats strip at the bottom right.

## Run it

```sh
npm install
npx install-electron   # first time only: downloads the Electron runtime
npm run dev            # Electron app with hot reload
```

Pick **Claude Code** or **Pi**, choose a project folder, then **Start session**.

**Tabs** each run their own session, so you can work on several projects, or both agents, at once. **+** or Ctrl+T opens a tab, Ctrl+W closes one (it asks first if the agent is mid-turn), Ctrl+Tab and Ctrl+1–9 switch. A tab's dot shows what it's doing: amber when the agent needs you, blue while it works, green when idle. Each tab keeps its own unsent message.
- A tab shows the session's name once the agent has one. Double-click a tab, or use its **⋯** menu, to rename it: Claude records the name through its `rename_session` control request, Pi through `set_session_name`.
- **⋯ → Export** saves the session where you choose: Pi writes it as an HTML page (`export_html`), and Claude's JSONL transcript is copied as is.

**The message box:**
- `/` at the start lists the agent's slash commands with their descriptions. Claude Code lists its commands after the first prompt, so Agent Deck remembers the last list per agent.
- `@` suggests files from the session's folder (git-tracked plus untracked, minus ignored; without git, a walk that skips `node_modules`, build output and hidden folders). Up/Down picks, Enter or Tab inserts, Esc closes.
- Paste or drop images (PNG, JPEG, GIF or WebP, up to 3.75 MB, five per message) to send them with the prompt.
- **Pi:** `!command` runs a shell command through Pi's `bash` RPC. Its output streams into a bash row and is added to the conversation. Esc stops it.
- A message sent while the agent works steers the running turn. With **Pi**, Alt+Enter queues it for after the turn instead: queued messages show above the message box until Pi takes them up, and **Clear** drops them. (Claude Code queues mid-turn messages itself.)

**Tool calls** show what they did: Edit and Write as a diff with `+`/`−` counts, shell commands as a terminal with their output, Read with its line range. When the agent keeps a task list (Claude's `TaskCreate`/`TaskUpdate`, or `TodoWrite`), a **Tasks** checklist appears above the subagents.
- **Claude Code hooks** show as **Hook** rows when they take longer than 1.5 seconds or fail, with what they printed. Quick, successful ones stay hidden: every launch runs SessionStart hooks, and those would only be noise. (Agent Deck passes `--include-hook-events`.)
- **Claude Code background tasks**, such as a shell command or subagent Claude moved to the background, get a card in the subagent panel with a **Stop** button (the `stop_task` control request). A backgrounded subagent keeps its card running after the turn ends, and the card ends with Claude's summary when the task finishes.

**Fork and restore:** hover over a message you sent in this session (while the agent is idle) for these actions:
- **Fork from here** continues from before that message on a new branch. The message's text goes back in the message box so you can edit and resend it, and the transcript drops everything from that point on.
  - **Claude Code** relaunches with `--resume <id> --fork-session --resume-session-at=<the reply before it>`, so the original session stays as it was.
  - **Pi** uses `get_fork_messages` and `fork`.
- **Restore files** (Claude Code only) puts files back as they were before that message. Agent Deck runs Claude with `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`, and each prompt carries its own uuid so it can be named later. A dry run lists the files and line counts and asks first. The conversation itself stays as it is.

**Model** and **Effort** can be changed before or during a session:
- **Claude Code:** choices are the CLI aliases (`fable`, `opus`, `sonnet`, `haiku`) and `--effort` levels. A change mid-session relaunches Claude with `--resume`, so the conversation continues. The relaunch waits for the current turn to finish.
- **Pi:** the model list and thinking levels come from Pi itself (`get_available_models`) once the session starts, and changes apply live over RPC.

**Mode** switches between **Auto** and **Plan**, before or during a session (Shift+Tab in the message box):
- **Auto:** the agent edits files and runs tools on its own.
- **Plan:** the agent is read-only. It explores, then proposes a plan. When a plan-mode turn ends, **Switch to Auto and run** approves the plan, or you can keep chatting to refine it.
- **Claude Code:** Plan is Claude's own `--permission-mode plan`, and Auto uses the `permissionMode` setting. Switching is live over the control channel, even mid-turn. If Claude leaves plan mode by itself, the toggle follows.
- **Pi with [`pi-plan`](https://www.npmjs.com/package/pi-plan)** (`pi install npm:pi-plan`): Agent Deck toggles it with `/plan`, live. Its "what next?" dialog becomes the approval step: **Switch to Auto and run** chooses *Execute*, so pi-plan runs the plan and tracks each step, and replying instead chooses *Stay* and sends your message. The toggle follows pi-plan, e.g. back to Auto when a plan is finished.
- **Pi without pi-plan:** Plan relaunches Pi on the same session with only `read,grep,find,ls` and `--no-mcp` (no bash, edit, write, MCP or subagent tools), and each prompt starts with a short instruction to answer with a plan.
- With either one, a Pi mode change waits for the current turn to finish.

Your last choice per agent is remembered.

**Advanced** (in the setup form) sets options that are fixed for the session's life. The ones in use show as an **Options** row in the stats strip; changing them means starting a new session. Your last choices per agent are remembered.
- **Claude Code:**
  - Text to add to the system prompt. It's written to a temp file and passed with the hidden `--append-system-prompt-file` flag, so long text never reaches the command line.
  - Extra folders (`--add-dir`), MCP config files (`--mcp-config`, optionally with `--strict-mcp-config`), a subagents file (`--agents`).
  - A budget cap (`--max-budget-usd`). When it's reached, a note in the transcript says so.
  - Fallback models (`--fallback-model`), allowed and disallowed tools (`--allowedTools`/`--disallowedTools`, e.g. `Bash(git *) Edit`).
  - Bare mode (`--bare`): no hooks, plugins, CLAUDE.md, memory or Claude login. It needs an `ANTHROPIC_API_KEY`.
- **Pi:**
  - Text to add to the system prompt (`--append-system-prompt` with a temp file).
  - Extra extensions for this session only (`-e npm:…`), no MCP (`--no-mcp`), skip AGENTS.md files (`-nc`).
  - Tools and excluded tools (`--tools`/`--exclude-tools`, with `*` patterns such as `mcp__docs__*`). Plan mode keeps its own read-only tools and `--no-mcp` whatever is set here; excluded tools still apply.
  - **Instructions** edits the project's `AGENTS.md`, its `.pi/APPEND_SYSTEM.md` (which applies once you trust the project in Pi), and your global `~/.pi/agent/AGENTS.md`. A `SYSTEM.md`, which replaces Pi's whole prompt, is shown but not editable here. Files are only read and written for folders you picked in the app or that a tab runs in. Changes apply from the next session.
- Values that start with `-` are dropped, so an option can't turn into another flag.

**Approvals:** when the agent needs you, a card appears above the message box, and the transcript says it is waiting for you. A tag shows when the request comes from a subagent.
- **Claude Code:** tool calls that the permission mode doesn't already allow ask first, with **Allow**, **Allow for session** (Claude's own suggested rule, kept for this session only) and **Deny**. Enter allows and Esc denies. `AskUserQuestion` shows its questions as choices. In Plan mode, a finished plan (`ExitPlanMode`) is the plan-approval step: **Switch to Auto and run** accepts it, and a reply sends your changes back to Claude.
- **Pi:** extension dialogs (`ctx.ui.select`, `confirm`, `input`, `editor`) become cards, so an extension that asks something no longer leaves Pi waiting forever. `ctx.ui.notify` messages appear inline. A dialog with a timeout disappears when Pi resolves it.
- Interrupting a turn dismisses its open cards.

**Context and health** live in the stats strip at the bottom right:
- **Claude Code:** click **Context** for a breakdown of where the context window goes (system prompt, tools, MCP, skills, messages, free space), from the `get_context_usage` control request.
- **Compact** summarizes the conversation so far to free context. It turns amber past 70% full and works when the agent is idle: Claude gets `/compact`, Pi the `compact` RPC. A divider in the transcript shows how much it freed. Compactions the agent does on its own show up the same way.
- When a provider request fails and the agent retries (Claude's `api_retry`, Pi's `auto_retry_start`), a **Retrying** row counts down to the next attempt with the reason.
- **Claude Code:** an **MCP** row shows how many servers connected. It's filled from the `mcp_status` control request as soon as the session starts, and from Claude's `init` record each turn. Click it to refresh and see each server's status, including entries skipped as invalid config. Each server can be managed from its row:
  - **Reconnect** a failed server.
  - **Sign in** to one that needs auth. The sign-in page opens in your browser (https links only), and the row updates once Claude takes the callback. Servers that need a custom redirect scheme say to finish with `claude /mcp` in a terminal.
  - **Disable** or **Enable** a server. This is saved to your Claude settings, not just the session, so Disable asks for a second click.
  - **Sign out** of an http/sse server.
  - Click a server's name for its version, where it's configured, and its tools (read-only ones are marked).
- **Pi:** when `~/.pi/agent/mcp.json` or the project's `.pi/mcp.json` exists, the MCP row lists Pi's servers from `pi mcp list --json`. It's read-only: Pi's own `/mcp` changes last one session, so use it (or `pi mcp` in a terminal) to manage servers. Plan mode runs with `--no-mcp`, so it lists nothing.
- **Claude Code:** plugins that fail to load, tool calls Claude refuses without asking, and an approaching or reached usage limit appear as notes in the transcript.

**Notifications:** while the window is in the background, a desktop notification says when the agent needs your approval or input, has a plan ready, finishes, or hits an error. Requests that need an answer also flash the taskbar button. Clicking a notification opens its tab.

**Previous sessions** for the chosen folder are listed under the setup form, from both agents and newest first. Opening one replays its transcript and subagent cards. **Continue session** relaunches the agent on it: Claude with `--resume`, Pi through the `switch_session` RPC. Sessions are read from `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`) and `~/.pi/agent/sessions` (or `PI_CODING_AGENT_SESSION_DIR` / `PI_CODING_AGENT_DIR`).

- `npm run dev:web` opens the UI in a browser with a scripted demo agent, with no Electron and no real agent. Use it for UI work.
- `npm test` runs the adapter and reducer tests against the JSONL fixtures in `test/fixtures/`.
- `npm run check` typechecks everything.
- `npm run dist` packages an installer into `release/` with [electron-builder](https://www.electron.build/) (NSIS on Windows, DMG on macOS, AppImage on Linux; see `electron-builder.yml`). `npm run dist:dir` builds the unpacked app only, which is quicker for checking a build. There's no app icon yet, so Electron's default is used.
- CI (`.github/workflows/ci.yml`) runs the typecheck, tests and build on every push to `main` and on pull requests.
- `PI_LIVE=1 npx vitest run test/live.test.ts` runs an end-to-end check against your installed Pi. It uses `openrouter/openrouter/free` by default; set `PI_LIVE_MODEL` to use another model. Add `PI_LIVE_SUBAGENT=1` to also run a real `pi-subagents` background run end to end.

## How it works

Each agent CLI runs as a child process speaking JSONL:

| Agent | Command | Subagents come from |
| --- | --- | --- |
| Claude Code | `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio` | `Task`/`Agent` tool calls; subagent messages carry `parent_tool_use_id` |
| Pi | `pi --mode rpc` | tools named in `piSubagentTools` (default `subagent`) |

Pi subagents come from extensions:
- **Foreground** extensions, like pi-mono's `subagent` example, finish inside the tool call.
- **Background** runs, which are the default in [`pi-subagents`](https://github.com/nicobailon/pi-subagents), return a run id right away.

For a background run, Agent Deck keeps the card running and follows the run's own `events.jsonl` to show its transcript live. It also shows the model that actually answered (e.g. the real model behind OpenRouter's free router). Status comes from the extension's status snapshots and `bg_wait` completions. Management calls on the same tool (`action: "list"`, `"guide"`, …) appear as ordinary tool calls, not subagents.

An adapter in `src/main/agents/` translates each agent's records into one normalized `AgentEvent` stream (`src/shared/events.ts`). A pure reducer (`src/shared/session.ts`) turns those events into UI state. To add another agent, write a translator plus adapter and register it in `src/main/agents/registry.ts`.

Main runs one adapter per tab and sends events to the renderer as `{ tab, event }`, batched once per frame. In the renderer, `session` and `view` (`src/renderer/src/lib/session.svelte.ts`) always point at the active tab, and `agent` sends calls for it.

The window is sandboxed (`sandbox: true`, context isolation, no Node in the renderer) under a strict Content-Security-Policy. Links open in your browser, and the window never navigates away from the app.

## Settings

Open **Settings** with the gear in the top bar. Changes apply from the next session. They're stored in `%APPDATA%/agent-deck/settings.json`:

- `claudePath`, `piPath`: binary names or paths. On Windows they're looked up on `PATH` and started without `cmd.exe` when possible: an `.exe` runs directly, and Pi's managed launcher (`~/.pi/agent/bin/pi.cmd`) or an npm `.cmd` shim is unwrapped to `node <cli.js>`. Other `.cmd`/`.bat` files still go through `cmd.exe`, which only accepts plain arguments (ids, paths without spaces, model names).
- `permissionMode`: Claude Code `--permission-mode` in Auto mode (Plan mode always uses `plan`). The default is `acceptEdits`; set `auto` to let Claude's classifier approve commands too, or `default` to approve every edit yourself.
- `approvals`: `ask` (the default) shows approvals and questions in the app. `deny` refuses anything that would need you, as before: Claude runs without `--permission-prompt-tool`, and Pi's extension dialogs are cancelled right away.
- `piSubagentTools`: Pi tool names to show as subagents.
- `notifications`: desktop notifications while the window is in the background (default on).
- `piAutoCompaction`: when `false`, Agent Deck turns off Pi's automatic compaction for its sessions (`set_auto_compaction`). Left on, Pi's own setting applies.
- `sessionOptions`: the last **Advanced** options used per agent.

**Pi packages:** **Settings → Pi → Packages…** manages Pi's packages (extensions, skills, prompts and themes):
- **Installed** lists yours (`~/.pi/agent/settings.json`) and this project's (`.pi/settings.json`), with versions and resource counts read from each package's `package.json`. It reads the files directly, because `pi list` hides project packages until the project is trusted.
- **Install** takes an npm or git source (`npm:pi-foo`, `npm:@scope/pi-foo@1.2.0`, `git:github.com/user/repo`). Local paths aren't supported here. **This project only** installs with `-l`. Every install, update and removal asks first, since packages run code on your machine. The command's output streams into the dialog.
- **Update**, **Remove** and **Update all** run `pi update <source>`, `pi remove <source>` and `pi update --extensions`. For a project package, Pi wants project trust, so Agent Deck adds `--approve` for that one command and says so when it asks. It never runs a bare `pi update`, which would update Pi itself.
- Pi has no reload command, so after a change **Reload Pi tabs** restarts each idle Pi tab on its session (busy ones restart when their turn ends). New sessions pick up changes on their own.
- **Discover** searches npm packages tagged `pi-package` (the list behind [pi.dev/packages](https://pi.dev/packages)). **Use** puts a result in the Install box; nothing installs until you confirm.
