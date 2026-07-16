# Claude Code parity: the feature catalog

personaxis is a living, governed persona agent AND a full interactive coding-agent CLI. This page
tracks parity with the features a modern coding agent (Claude Code / Codex) exposes, plus the
personaxis-native capabilities no other agent has (drift, governance, the persona fleet).

Legend: **done** shipped and tested · **partial** usable, being extended · **planned** on the
roadmap (`plan/IMPLEMENTATION_CHECKLIST.md`, section V2-F3).

## A. Session & context

| Capability | Status | Where |
|---|---|---|
| Persistent sessions (`/sessions`, `/resume`) | done | `packages/core/src/sessions.ts` |
| `--continue` / `--resume [id]` startup flags | done | `packages/cli/src/index.ts`, `repl/session.ts` (`resumeSessionInto`) |
| `/compact` (summarize older turns, persisted) | done | `repl/commands.ts`, `core/src/context.ts` |
| `/status` (model · posture · drift · memory · session · context) | done | `repl/commands.ts` |
| `/context` (window usage + compact hint) | done | `repl/commands.ts` |
| `@file` mentions with fuzzy completion | planned | |
| Headless `-p` with `--output-format json` | partial (line mode exists) | `repl/index.ts` |
| Input queue while responding · Esc to interrupt | planned | |

## B. Tools & permissions

| Capability | Status | Where |
|---|---|---|
| File + shell tools (read/write/edit/glob/grep/bash) | done | `core/src/tools/registry.ts` |
| `memory_search` / `memory_get` tools | done | `core/src/memory/retrieval.ts` |
| Sandbox postures (read-only / workspace-write / full) | done | `core/src/sandbox.ts` |
| Persistent permission allowlist/denylist | planned | |
| Background tasks (`/bg`, `/tasks`) | partial (serve/watch daemons) | `repl/daemons.ts` |
| MCP client (mount external MCP servers as tools) | planned | (server side ships in `@personaxis/mcp`) |

## C. Extensibility

| Capability | Status | Where |
|---|---|---|
| Skills (`extensions.skills`, materialized on compile) | done | `cli/src/targets/skills.ts` |
| Custom slash commands (`.personaxis/commands/*.md`) | done | `cli/src/repl/custom-commands.ts` |
| User lifecycle hooks (session-start/pre-tool/post-tool) | partial (host hooks exist) | `core/src/hooks.ts` |
| Sub-persona delegation with a budget | partial (@mention routing) | `repl/turn.ts` |

## D. Observability & control

| Capability | Status | Where |
|---|---|---|
| `/context` (window usage + compact hint) | done | `repl/commands.ts` |
| `/doctor` (config · provider ping · persona · memory chain · version) | done | `repl/commands.ts` |
| `/cost` / `/usage` (per-session tokens + cost) | done | `repl/commands.ts`, `repl/turn.ts` (cumulative accounting) |
| `/help` by category with `/help <query>` filter | done | `repl/commands.ts` |
| `/rewind` (per-turn checkpoint restore) | planned | (mutation_log is the basis) |
| Configurable keybindings / statusline | planned | |

## E. personaxis-native (no other agent has these)

| Capability | Status | Where |
|---|---|---|
| The Command Center (stable alt-screen hub) | done | `cli/src/command-center.tsx` |
| Live drift + band-crossing moments | done | `tui/src/components.tsx`, `core/src/math/` |
| Governed self-edits (`/review`, Proposals section) | done | `core/src/self-evolution.ts` |
| Cross-session memory + user profile | done | `core/src/memory/` |
| Persona fleet (`personaxis ps`, live status) | planned (F4) | |
| Verifiable identity (sigil + hash-chain) | done | `core/src/sigil.ts`, `core/src/memory.ts` |

Items marked **planned** are not stubs: each has an execution entry in
`plan/IMPLEMENTATION_CHECKLIST.md` (V2-F3/F4). This table is the single place a contributor checks
before adding a feature, to avoid duplicating one that already exists under a different name.
