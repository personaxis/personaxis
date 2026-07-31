# Target matrix: which agent hosts read which file (V4.3 audit, 2026-07)

The discovery chain is the distribution (business v4): agents read their default files, and
personaxis compiles the governed persona INTO those files. This audit answers one question:
**which real ecosystems read something other than AGENTS.md/CLAUDE.md/SOUL.md**, because
per doc 10 we add plugin targets only where a real ecosystem reads a different file.

| Host / ecosystem | Default-read file | Covered by |
|---|---|---|
| Claude Code | `CLAUDE.md` (+ `.claude/agents/*.md` subagents) | `claude-code` target + baseline injection |
| OpenAI Codex CLI/IDE | `AGENTS.md` (+ `.codex/agents/*.toml`) | `codex` target + baseline injection |
| Cursor | `AGENTS.md` (native support) | AGENTS.md baseline |
| Zed, Amp, Jules, Factory, Roo, Cline, Windsurf | `AGENTS.md` (the 60K+ repo ecosystem) | AGENTS.md baseline |
| OpenClaw | `SOUL.md` | `openclaw` target (full SOUL.md) |
| Hermes | `.hermes/SOUL.md` | `hermes` target |
| **Gemini CLI** | **`GEMINI.md`** (configurable, but this is the default) | **V4.3: baseline refreshed when the file exists** |
| **GitHub Copilot (VS Code)** | **`.github/copilot-instructions.md`** (the coding agent also reads AGENTS.md) | **V4.3: baseline refreshed when the file exists** |
| Aider | `CONVENTIONS.md` (opt-in flag, small persona surface) | not targeted (no default read) |

## The verdict, in code

`personaxis compile --root` refreshes the `PERSONA:BASELINE` block in every root context
file the project ACTUALLY has: `CLAUDE.md` and/or `AGENTS.md` (created only if neither
exists), plus `GEMINI.md` and `.github/copilot-instructions.md` **only when present**,
never creating them (no litter for hosts the project does not use). Implementation:
`injectRootBaselines` / `injectSecondaryBaselines` in `packages/cli/src/commands/compile.ts`.

## Rules for adding a new target

1. The host must have a REAL ecosystem (not a spec proposal).
2. If it reads AGENTS.md or CLAUDE.md, it is already covered; do nothing.
3. If it reads a different MARKDOWN context file at a stable path, add it to
   `injectSecondaryBaselines` (refresh-when-present).
4. Only hosts with their own document format or placement convention (like Codex TOML
   subagents or SOUL.md) justify a full `CompileTarget` plugin
   (`packages/core/src/compile/targets.ts`, `registerTarget`).
