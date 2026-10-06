# How a coding agent loads a persona

`personaxis compile --platform <host>` writes a persona where Claude Code, Codex, OpenClaw or Hermes
read it. This page lists where each file goes and why. The code is in
`packages/cli/src/targets/` and `packages/cli/src/commands/compile.ts`.

## Compile targets

The supported hosts are exactly the ones in `PLACEMENT_PLATFORMS` (`packages/cli/src/targets/placement.ts`):

| Host | Root output | Sub-persona output |
|---|---|---|
| `claude-code` | `PERSONA.md` plus `@PERSONA.md` injected into `CLAUDE.md` | `.claude/agents/<slug>.md` |
| `codex` | `PERSONA.md` plus an `AGENTS.md` baseline | `.codex/agents/<slug>.toml` |
| `openclaw` | `SOUL.md` (workspace root) | `.openclaw/agents/<slug>/SOUL.md` |
| `hermes` | `.hermes/SOUL.md` (profile) | `.hermes/agents/<slug>/SOUL.md` |

Other hosts that read `AGENTS.md` (Cursor and most others) pick up the Codex baseline; see
[target-matrix](./target-matrix.md).

## OpenClaw and Hermes: SOUL.md

Both read `SOUL.md` as the first section of the agent's system prompt (OpenClaw from the workspace
root, Hermes from `~/.hermes/SOUL.md` or a per-profile file). `compile --platform openclaw` or
`hermes` writes the compiled document as `SOUL.md` with the sub-agent frontmatter stripped
(`packages/cli/src/targets/soul-md.ts`). These hosts auto-load `SOUL.md`, so they skip the
`@PERSONA.md` baseline. For Hermes, point your profile at the generated `.hermes/SOUL.md` or copy it
to `~/.hermes/SOUL.md`.

Claude Code and Codex resolve file includes, so `CLAUDE.md` and `AGENTS.md` can reference
`PERSONA.md` and it stays the single file. OpenClaw and Hermes do not document includes inside
`SOUL.md`, so `SOUL.md` holds the compiled document itself. The source is still one file:
`personaxis.md` compiles to both `PERSONA.md` and `SOUL.md`, and `compile` and `observe` regenerate
`SOUL.md` when the persona changes. Both hosts also read `AGENTS.md`, so an `@PERSONA.md` reference
there works too.

## Keeping the loaded persona current

Compiling places the document. The persona learns from each turn through a hook that runs
`personaxis observe` on your configured model, with no host tokens spent
(`personaxis hooks install --host claude-code`). See [the Claude Code integration](../integrations/claude-code.md)
and [deployment](./deployment.md).

## The flow

1. Define the persona once as `personaxis.md`, then run `personaxis validate`.
2. `personaxis compile` produces the document and places it where the host looks.
3. The host reads the baseline as the repo-wide behavior and sends task-specific work to the
   sub-agents by their `description`. The canonical `.personaxis/personas/<slug>/PERSONA.md` stays
   the source; the host file is an export.

## What this gives you

- One source for every host. You do not rewrite the prompt for each tool, and `@slug` in the REPL
  never collides with a host's sub-agent mechanism, because the persona is compiled into that mechanism.
- The compiled document uses the techniques in [persona-prompting](./persona-prompting.md): role
  adoption, a character card, scene contracts, voice exemplars and break-character guardrails.
- A persona carries its own `permissions` (sandbox and approval), verification gates and budget
  caps, so the limits travel with it across hosts and operating systems.

A hand-written agent file is edited by each contributor and has no check. A persona is validated by
`personaxis validate`, compiled by `personaxis compile`, and diffable in git.

```bash
personaxis compile --root                 # writes PERSONA.md and injects @PERSONA.md into CLAUDE.md
personaxis compile cmo --platform codex   # writes the canonical PERSONA.md and .codex/agents/cmo.toml
```
