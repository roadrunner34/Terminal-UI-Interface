# Agent Deck

A desktop UI for local coding agents (Claude Code and Pi). Chat with the agent on the left (80%), watch its subagents on the right (20%), and keep an eye on tokens, context and cost in the stats strip at the bottom right.

## Run it

```sh
npm install
npx install-electron   # first time only: downloads the Electron runtime
npm run dev            # Electron app with hot reload
```

Pick **Claude Code** or **Pi**, choose a project folder, then **Start session**.

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

**Previous sessions** for the chosen folder are listed under the setup form, from both agents and newest first. Opening one replays its transcript and subagent cards. **Continue session** relaunches the agent on it: Claude with `--resume`, Pi through the `switch_session` RPC. Sessions are read from `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`) and `~/.pi/agent/sessions` (or `PI_CODING_AGENT_SESSION_DIR` / `PI_CODING_AGENT_DIR`).

- `npm run dev:web` opens the UI in a browser with a scripted demo agent, with no Electron and no real agent. Use it for UI work.
- `npm test` runs the adapter and reducer tests against the JSONL fixtures in `test/fixtures/`.
- `npm run check` typechecks everything.
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

## Settings

Settings are stored in `%APPDATA%/agent-deck/settings.json`:

- `claudePath`, `piPath`: binary names or paths.
- `permissionMode`: Claude Code `--permission-mode` in Auto mode (Plan mode always uses `plan`). The default is `acceptEdits`; set `auto` to let Claude's classifier approve commands too, or `default` to approve every edit yourself.
- `approvals`: `ask` (the default) shows approvals and questions in the app. `deny` refuses anything that would need you, as before: Claude runs without `--permission-prompt-tool`, and Pi's extension dialogs are cancelled right away.
- `piSubagentTools`: Pi tool names to show as subagents.
