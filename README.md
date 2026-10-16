# Syzygy

Codex and Claude Code in one terminal UI. One agent is **main**: it talks to you and can hand work to the other (the **subagent**) through an MCP tool. Both run on your existing subscriptions: Syzygy drives the official, logged-in CLIs (`codex app-server` and `claude -p` stream-json). It never calls the APIs directly.

Defaults:

- **Main:** Codex, newest Sol model at low effort
- **Subagent:** Claude, Opus at medium effort

Choices are stored as *families* (`sol`, `opus`), not model ids. Each session start resolves a family to the newest model your account can actually use, so a provider upgrade is picked up without any change.

## Run

```bash
bun install
bun src/cli.tsx [project-dir] [--main codex|claude]
bun link          # optional: puts `syzygy` on your PATH (~/.bun/bin)
```

Requires [Bun](https://bun.sh), plus `codex` and `claude` on PATH, both logged in (`codex login`, `claude auth login`). Run `bun src/cli.tsx doctor` to check a machine.

Runs on Linux and macOS. `/paste` (clipboard image) uses `wl-paste` on Wayland, `xclip` on X11, and `pngpaste` (if installed) or `osascript` on macOS. `@path` and drag-and-drop work without any of these.

### On another machine

```bash
git clone <repo-url> ~/Repos/syzygy && cd ~/Repos/syzygy
bun install
bun src/cli.tsx doctor     # checks CLIs, logins, flags, models, clipboard
bun run gen:codex          # only if that machine's codex version differs (bindings are typed for codex-cli 0.158)
```

Sessions and settings are per machine (`~/.local/share/syzygy`), as is each provider's own history. Shared project memory lives in each project's `.syzygy/MEMORY.md`, so it travels with that project.

## Using it

| Action | How |
|---|---|
| Attach a file or folder | `@path`, `@"path with spaces"`; Tab completes |
| Attach an image | `@shot.png`, drag a file into the terminal, or `/paste` (clipboard) |
| Models, effort, approvals | `/model` (save globally or per project) |
| Switch main agent | `/main claude`, or `/new codex` for a single session |
| Sessions | `/sessions` (a = archive), `/archived` (a or Enter = restore), `/new` |
| Projects | `/project <path>`, `/projects` |
| Shared memory | `/remember <note>`, `/memory` |
| Interrupt | Esc (stops main and running subagents) |
| Subagent panel | Tab (when there is no `@path` to complete) |

Approvals: in `ask` mode, Codex approvals (app-server requests) and Claude permission prompts (`--permission-prompt-tool`) appear in the TUI as y/n prompts. Each CLI's own allow-lists still apply. In `auto` mode, Codex runs with `never` (workspace-write sandbox) and Claude runs in its `auto` permission mode.

## How it works

```
TUI (Ink) ──events──▶ Core ──▶ CodexAdapter ── JSON-RPC ──▶ codex app-server
                        │ ──▶ ClaudeAdapter ── stream-json ─▶ claude -p (one per session)
                        │
                        └── Bridge (unix socket) ◀── syzygy MCP server ◀── spawned by the main agent
                                                     tools: delegate, followup, approve
```

- **Delegation:** the main agent calls `delegate(task, files?, model?, effort?)`. The core starts a subagent session in the same project directory, streams its progress to the TUI, and returns the final report plus a `subagent_id`. `followup(subagent_id, message)` continues that subagent with its context intact, even after a restart. A subagent's MCP token only grants `approve`, so subagents cannot delegate further. This is not a hard security boundary, because all agents run as your OS user.
- **Memory:** each CLI keeps its own native memory (`AGENTS.md`, `CLAUDE.md`, auto-memory). `<project>/.syzygy/MEMORY.md` is shared by both and injected into main and subagent instructions.
- **Storage:** `~/.local/share/syzygy/syzygy.db` (SQLite; override with `SYZYGY_HOME`) holds projects, sessions, the provider session ids used for resume, a display copy of transcripts, subtasks and settings. The real conversation context stays with each provider (`~/.codex/sessions`, `~/.claude/projects`). Archiving a Codex session also archives it in Codex itself.

## Development

```bash
bun test                          # unit tests
bun run typecheck
bun scripts/smoke.ts [codex|claude]                 # one live turn per provider
bun scripts/delegate.ts <main> [sub family]         # live delegation round trip
bun scripts/tui-drive.ts <dir> "/help" "<enter>"    # drive the TUI in a pty
bun run gen:codex                 # regenerate app-server bindings after a codex upgrade
```
