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

**The message box:**
- `/` at the start lists the agent's slash commands with their descriptions. Claude Code lists its commands after the first prompt, so Agent Deck remembers the last list per agent.
- `@` suggests files from the session's folder (git-tracked plus untracked, minus ignored; without git, a walk that skips `node_modules`, build output and hidden folders). Up/Down picks, Enter or Tab inserts, Esc closes.
- Paste or drop images (PNG, JPEG, GIF or WebP, up to 3.75 MB, five per message) to send them with the prompt.

**Tool calls** show what they did: Edit and Write as a diff with `+`/`−` counts, shell commands as a terminal with their output, Read with its line range. When the agent keeps a task list (Claude's `TaskCreate`/`TaskUpdate`, or `TodoWrite`), a **Tasks** checklist appears above the subagents.

**Model** and **Effort** can be changed before or during a session:
- **Claude Code:** choices are the CLI aliases (`fable`, `opus`, `sonnet`, `haiku`) and `--effort` levels. A change mid-session relaunches Claude with `--resume`, so the conversation continues. The relaunch waits for the current turn to finish.
- **Pi:** the model list and thinking levels come from Pi itself (`get_available_models`) once the session starts, and changes apply live over RPC.

**Mode** switches between **Auto** and **Plan**, before or during a session (Shift+Tab in the message box):
- **Auto:** the agent edits files and runs tools on its own.
- **Plan:** the agent is read-only. It explores, then proposes a plan. When a plan-mode turn ends, **Switch to Auto and run** approves the plan, or you can keep chatting to refine it.
- **Claude Code:** Plan is Claude's own `--permission-mode plan`, and Auto uses the `permissionMode` setting. Switching is live over the control channel, even mid-turn. If Claude leaves plan mode by itself, the toggle follows.
- **Pi with [`pi-plan`](https://www.npmjs.com/package/pi-plan)** (`pi install npm:pi-plan`): Agent Deck toggles it with `/plan`, live. Its "what next?" dialog becomes the approval step: **Switch to Auto and run** chooses *Execute*, so pi-plan runs the plan and tracks each step, and replying instead chooses *Stay* and sends your message. The toggle follows pi-plan, e.g. back to Auto when a plan is finished.
- **Pi without pi-plan:** Plan relaunches Pi on the same session with only `read,grep,find,ls` (no bash, edit, write or subagent tools), and each prompt starts with a short instruction to answer with a plan.
- With either one, a Pi mode change waits for the current turn to finish.

Your last choice per agent is remembered.

**Approvals:** when the agent needs you, a card appears above the message box, and the transcript says it is waiting for you. A tag shows when the request comes from a subagent.
- **Claude Code:** tool calls that the permission mode doesn't already allow ask first, with **Allow**, **Allow for session** (Claude's own suggested rule, kept for this session only) and **Deny**. Enter allows and Esc denies. `AskUserQuestion` shows its questions as choices. In Plan mode, a finished plan (`ExitPlanMode`) is the plan-approval step: **Switch to Auto and run** accepts it, and a reply sends your changes back to Claude.
- **Pi:** extension dialogs (`ctx.ui.select`, `confirm`, `input`, `editor`) become cards, so an extension that asks something no longer leaves Pi waiting forever. `ctx.ui.notify` messages appear inline. A dialog with a timeout disappears when Pi resolves it.
- Interrupting a turn dismisses its open cards.

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

- `claudePath`, `piPath`: binary names or paths.
- `permissionMode`: Claude Code `--permission-mode` in Auto mode (Plan mode always uses `plan`). The default is `acceptEdits`; set `auto` to let Claude's classifier approve commands too, or `default` to approve every edit yourself.
- `approvals`: `ask` (the default) shows approvals and questions in the app. `deny` refuses anything that would need you, as before: Claude runs without `--permission-prompt-tool`, and Pi's extension dialogs are cancelled right away.
- `piSubagentTools`: Pi tool names to show as subagents.
- `notifications`: desktop notifications while the window is in the background (default on).
