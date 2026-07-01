# How big agents adopt a personaxis persona

*How does Claude Code / Codex actually "become" a persona for a repo, or pick up
sub-personas for specific tasks — and why is this better than hand-written agent prompts?*

Source: `packages/cli/src/targets/{claude-code.ts, codex.ts, placement.ts}`;
`packages/cli/src/commands/compile.ts`.

## Supported compile targets

`personaxis compile --platform <p>` places the compiled document into a host's subagent convention.
The live targets are exactly those in `PLACEMENT_PLATFORMS` (`packages/cli/src/targets/placement.ts`):

| Target | Status | Root output | Sub-persona output |
|---|---|---|---|
| `claude-code` | **Live** | `PERSONA.md` + `@PERSONA.md` injected into `CLAUDE.md` | `.claude/agents/<slug>.md` |
| `codex` | **Live** | `PERSONA.md` + `AGENTS.md` baseline | `.codex/agents/<slug>.toml` |
| `cursor` | Archived | `.cursor/rules/persona.mdc` | — |
| `soul-md` | Archived | `SOUL.md` | — |

There is **no `hermes` compile target**. Hermes appears only in the research/planning notes and in
comparative prose ("complement Claude Code / Codex / Hermes"); the SOUL.md identity-slot format that
Hermes popularized survives here only as the **archived** `soul-md` export. Do not treat Hermes as an
adoption path — the real targets are `claude-code` and `codex`.

> **Per-turn liveness comes from hooks (Modo 1).** Compiling places a fresh identity; keeping it
> *alive* each turn is the Claude Code `Stop` hook (`personaxis hooks install --host claude-code`),
> which runs one governed tick on your model per turn — no host tokens. See
> [../integrations/claude-code.md](../integrations/claude-code.md) and
> [deployment.md](./deployment.md).

## The flow

1. **Define once** — a governed, versioned `personaxis.md` (quantitative layers +
   `persona_prompting` source material). Validated by `personaxis validate`.
2. **Compile to the host's native convention** — `personaxis compile` produces the
   LLM-facing document and places it where the host looks:

   | Host | Root persona | Sub-persona |
   |---|---|---|
   | Claude Code | `PERSONA.md` + a `@PERSONA.md` reference injected into `CLAUDE.md` | `.claude/agents/<slug>.md` (frontmatter `name`/`description`) |
   | Codex | `PERSONA.md` + `AGENTS.md` baseline | `.codex/agents/<slug>.toml` |

3. **The host routes** — Claude Code/Codex read the baseline as the repo-wide behavior and
   dispatch task-specific work to the subagents by their `description`. The canonical
   `.personaxis/personas/<slug>/PERSONA.md` stays the source; the host file is an export.

## What we facilitate (the value)

- **One source, many hosts.** The same persona compiles to each host's format, so you never
  re-author the prompt per tool, and there is no format collision between `@slug` (our CLI)
  and the host's subagent mechanism — we compile *into* that mechanism.
- **Persona-prompting, not a profile.** The compiled doc applies evidence-based techniques
  (role adoption, character card, scene contracts, voice exemplars, break-character
  guardrails) so the model genuinely *adopts* the role — see
  `persona.md/docs/PERSONA_PROMPTING.md`.
- **Governed + living.** Versioned spec, append-only hash-chained memory, governed
  self-improvement, reversibility, protected paths, per-persona sandbox posture. A plain
  hand-written `CLAUDE.md`/agent prompt has none of this.
- **Portable guarantees.** The persona carries its own `permissions` (sandbox/approval),
  verification gates, and budget caps, so behavior is consistent across hosts and OSes.

## Why it's better than the common way

The common way is a static `.md` per agent that every contributor edits by hand and that
silently drifts. personaxis makes the persona a **typed, validated, versioned, governed
artifact** with a compile step — you get diffable identity, auditable evolution, reusable
sub-personas, and a single definition that targets every host. The CLI is the toolchain that
keeps all of that honest (validate / lint / compile / decompile / push / pull).

## Verify it yourself

```bash
personaxis compile --root                 # writes PERSONA.md + injects @PERSONA.md into CLAUDE.md
personaxis compile cmo --platform codex   # writes the canonical PERSONA.md AND .codex/agents/cmo.toml
```
