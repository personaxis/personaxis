# `personaxis compile`

Compile `personaxis.md` into `PERSONA.md`, the document an agent reads to work the way this
persona works. `--platform` writes it where Claude Code, Codex, OpenClaw or Hermes look for
it. See [compile](../architecture/compile.md) and
[self-evolution](../architecture/self-evolution.md).

## Usage
```bash
personaxis compile [slug] [options]
```
- no slug / `--root` → compile the ROOT persona to `<repo>/PERSONA.md`.
- `<slug>` → compile a sub-persona to `.personaxis/personas/<slug>/PERSONA.md` (inside its folder).
- nested: `compile cmo/legal` → `.personaxis/personas/cmo/personas/legal/PERSONA.md`.

## Options
| Flag | Meaning |
|---|---|
| `--root` | Compile the root persona (default when no slug). |
| `--provider <name>` | Override the provider (`local \| byok \| agent`). |
| `--from-file <path>` | Use a file's contents as the compiled output instead of calling the LLM. |
| `-o, --out <path>` | Override the canonical output path. |
| `--stdout` | Print to stdout instead of writing. |
| `--platform <p>` | Export the placement for a host: `claude-code \| codex \| openclaw \| hermes`. |
| `--if-pending` | No-op unless a self-edit marked the doc stale (`.recompile-pending.json`). |
| `--no-polish` | Write the deterministic assembled document and skip the model polish stage (works offline). |

## What it does
- Reads `personaxis.md` + `policy.yaml`/`state.json` (reference) + a capped resource manifest.
- Folds **applied governed self-edits** (the active overlay) as authoritative overrides.
- Assembles a second-person document: role adoption, character card, voice exemplars, scene
  contracts, behavioral anchors, break-character guardrails, hard limits, memory/resources.
- Clears the recompile-pending marker on success.
- Root compile also injects the `@PERSONA.md` baseline block for the hosts that read one.

## Where each host reads the persona
`--platform` writes the file that host actually looks for. The two baseline hosts read the
canonical `PERSONA.md` through a managed block in a root file; the two SOUL hosts read a
`SOUL.md` injected as the first section of their system prompt and re-read it each message.

| Host | Main persona | Sub-persona |
|---|---|---|
| `claude-code` | `PERSONA.md` + block in `CLAUDE.md` | `.claude/agents/<slug>.md` |
| `codex` | `PERSONA.md` + block in `AGENTS.md` | `.codex/agents/<slug>.toml` |
| `openclaw` | `SOUL.md` | `.openclaw/agents/<slug>/SOUL.md` |
| `hermes` | `.hermes/SOUL.md` | `.hermes/agents/<slug>/SOUL.md` |

Baseline policy: **with** `--platform`, that host's baseline is created if missing (you
asked for the host, so you get it). **Without** `--platform`, existing baselines are
refreshed and `CLAUDE.md` is created only when the project has none, so a project never
gains baselines for hosts it does not use. SOUL hosts get no baseline: they auto-load
`SOUL.md`. `personaxis hooks install --host <host>` then feeds each turn back to the
persona; see [hooks](./hooks.md).

## Examples
```bash
personaxis compile --root
personaxis compile --root --platform codex        # PERSONA.md + AGENTS.md baseline
personaxis compile --root --platform hermes       # .hermes/SOUL.md (no baseline needed)
personaxis compile cmo --platform claude-code     # canonical + .claude/agents/cmo.md
PERSONAXIS_ENDPOINT=https://api.cohere.ai/compatibility/v1 \
PERSONAXIS_MODEL=command-a-03-2025 PERSONAXIS_API_KEY=… \
  personaxis compile cmo --provider local
personaxis compile --root --if-pending            # only if a self-edit made it stale
```

## While it runs

The polish stage calls a model and can take a while. While it runs, `personaxis ps` shows the
persona as compiling, and under `watch` it returns to `watching for spec edits` on its own.
See [presence](../architecture/presence.md).
