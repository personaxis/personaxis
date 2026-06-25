# `personaxis compile`

Compile a `personaxis.md` (quantitative spec + `persona_prompting` source) into the
LLM-facing **PERSONA.md** — a persona-prompting artifact (see
[../architecture/compile.md](../architecture/compile.md) and
[../architecture/self-evolution.md](../architecture/self-evolution.md)).

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
| `--provider <name>` | Override the provider (`local \| byok \| agent \| remote`). |
| `--from-file <path>` | Use a file's contents as the compiled output instead of calling the LLM. |
| `-o, --out <path>` | Override the canonical output path. |
| `--stdout` | Print to stdout instead of writing. |
| `--platform <p>` | ALSO export a host placement for a sub (`.claude/agents` / `.codex`). |
| `--if-pending` | No-op unless a self-edit marked the doc stale (`.recompile-pending.json`). |

## What it does
- Reads `personaxis.md` + `policy.yaml`/`state.json` (reference) + a capped resource manifest.
- Folds **applied governed self-edits** (the active overlay) as authoritative overrides.
- Assembles a second-person document: role adoption, character card, voice exemplars, scene
  contracts, behavioral anchors, break-character guardrails, hard limits, memory/resources.
- Clears the recompile-pending marker on success.
- Root compile also injects `@PERSONA.md` into `CLAUDE.md` / `AGENTS.md`.

## Examples
```bash
personaxis compile --root
personaxis compile cmo --platform claude-code     # canonical + .claude/agents/cmo.md
PERSONAXIS_ENDPOINT=https://api.cohere.ai/compatibility/v1 \
PERSONAXIS_MODEL=command-a-03-2025 PERSONAXIS_API_KEY=… \
  personaxis compile cmo --provider local
personaxis compile --root --if-pending            # only if a self-edit made it stale
```
