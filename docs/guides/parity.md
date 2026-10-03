# Coding-agent parity: the feature catalog

personaxis runs a persona as a working agent in the terminal, so it is measured here against the
features a modern coding-agent CLI (Claude Code, Codex) exposes, plus the capabilities that are
specific to a governed persona. Checked against the code on 2026-10-03.

Legend: **done** shipped and tested · **partial** usable, with the limit stated · **not yet** absent
in this version.

## A. Session and context

| Capability | Status | Where |
|---|---|---|
| Persistent sessions, resumed with `/resume` | done | `core/src/sessions.ts` |
| `--continue` / `--resume [id]` at startup | done | `cli/src/index.ts`, `repl/session.ts` |
| `/compact`, and automatic compaction near the window | done | `repl/compact.ts`, `core/src/context.ts` |
| `/status` (model, posture, drift, memory, session, usage, daemons) | done | `repl/views/settings-data.ts` |
| `/context` (window usage and what fills it) | done | `repl/commands.ts` |
| `@path` file mentions | done | `repl/mentions.ts` |
| Headless `-p` with `--output-format text \| json \| stream-json` | done | `repl/headless.ts` |
| Typing while the persona responds, Esc to interrupt a turn | not yet | |

## B. Tools and permissions

| Capability | Status | Where |
|---|---|---|
| File and shell tools (read, list, find, write, edit, run) | done | `core/src/tools/registry.ts` |
| Memory tools | done | `core/src/memory/retrieval.ts` |
| Sandbox postures (read-only, workspace-write, full access), `shift+tab` to cycle | done | `core/src/sandbox.ts` |
| Persistent allow/deny rules for tool calls | done | `permissions` in the config (`cli/src/config.ts`) |
| Background tasks (`/bg`) | done | `repl/tasks.ts`, `repl/daemons.ts` |
| MCP client: mount external MCP servers as tools | done | `personaxis mcp add/list/remove`, `cli/src/mcp/` |
| Web search | done, with a search provider key | `personaxis web`, the `web_search` tool |

## C. Extensibility

| Capability | Status | Where |
|---|---|---|
| Skills (`extensions.skills`, materialized on compile, `use_skill` at runtime) | done | `cli/src/targets/skills.ts` |
| Custom slash commands (`.personaxis/commands/*.md`) | done | `repl/custom-commands.ts` |
| Lifecycle hooks (`hooks.json` beside the persona: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`) | done | `core/src/hooks.ts` |
| Delegation to sub-personas and colleagues | done | the `delegate` tool, `core/src/run/colleagues.ts` |
| Services: a repeatable job with steps (`run_service`) | done | `personaxis service` |

## D. Observability and control

| Capability | Status | Where |
|---|---|---|
| `/doctor` (config, provider, spec, lint, memory chain, version) | done | `repl/doctor-checks.ts` |
| Usage and cost per session | done | `/status → Usage` |
| `/help` by category, `/help <query>`, `/help moved` | done | `repl/commands.ts` |
| Rewind state to before the last N moves, recorded | done | `/audit → Timeline`, `personaxis state rewind <n>` |
| Configurable statusline | done | `statusline` in the config |
| Configurable keybindings | not yet | |

## E. Specific to a governed persona

| Capability | Status | Where |
|---|---|---|
| The Command Center (`/menu`, `personaxis menu`) | done | `cli/src/command-center.tsx` |
| Drift on three planes, with band crossings | done | `/drift`, `personaxis drift` |
| Governed self-edits with a review queue | done | `/persona → Evolution`, `personaxis review` |
| Memory across sessions, by kind | done | `/memory`, `personaxis memory` |
| Persona fleet: who holds each persona, through what surface | done | `personaxis ps` |
| Hash-chained record, tamper located on replay | done | `/audit → Integrity`, `core/src/record/` |
| Enforcing the persona's policy on Claude Code and Codex running here | done | `personaxis guard` |
