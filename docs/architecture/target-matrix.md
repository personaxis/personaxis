# Target matrix: which agent hosts read which file

Agents read their default files, so personaxis compiles the persona into those files. This table
lists which files real hosts read, and which hosts read something other than
`AGENTS.md`, `CLAUDE.md` or `SOUL.md`, because a plugin target is added only where a real ecosystem
reads a different file.

| Host / ecosystem | Default-read file | Covered by |
|---|---|---|
| Claude Code | `CLAUDE.md` (+ `.claude/agents/*.md` subagents) | `claude-code` target + baseline injection |
| OpenAI Codex CLI/IDE | `AGENTS.md` (+ `.codex/agents/*.toml`) | `codex` target + baseline injection |
| Cursor | `AGENTS.md` (native support) | AGENTS.md baseline |
| Zed, Amp, Jules, Factory, Roo, Cline, Windsurf | `AGENTS.md` | AGENTS.md baseline |
| OpenClaw | `SOUL.md` | `openclaw` target (full SOUL.md) |
| Hermes | `.hermes/SOUL.md` | `hermes` target |
| Gemini CLI | `GEMINI.md` (configurable, but this is the default) | baseline refreshed when the file exists |
| GitHub Copilot (VS Code) | `.github/copilot-instructions.md` (the coding agent also reads AGENTS.md) | baseline refreshed when the file exists |
| Aider | `CONVENTIONS.md` (opt-in flag, small persona surface) | not targeted (no default read) |

## The verdict, in code

`personaxis compile --root` refreshes the `PERSONA:BASELINE` block in every root context
file the project actually has: `CLAUDE.md` and/or `AGENTS.md` (created only if neither
exists), plus `GEMINI.md` and `.github/copilot-instructions.md` only when present,
never creating them (no litter for hosts the project does not use). Implementation:
`injectRootBaselines` / `injectSecondaryBaselines` in `packages/cli/src/commands/compile.ts`.

## Rules for adding a new target

1. The host must have a real ecosystem, not a spec proposal.
2. If it reads AGENTS.md or CLAUDE.md, it is already covered; do nothing.
3. If it reads a different markdown context file at a stable path, add it to
   `injectSecondaryBaselines` (refresh-when-present).
4. Only hosts with their own document format or placement convention (like Codex TOML
   subagents or SOUL.md) justify a full `CompileTarget` plugin
   (`packages/core/src/compile/targets.ts`, `registerTarget`).
