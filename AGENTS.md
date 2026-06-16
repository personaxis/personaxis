# AGENTS.md

Instructions for AI agents working on the `@personaxis/persona.md` CLI repository.

## What this repo is

The reference CLI implementation of the [personaxis.md spec v0.7.0](https://github.com/personaxis/persona.md) (Personaxis v12). Published to npm as `@personaxis/persona.md`.

v0.7.0 is a layout-only move on top of v0.6.0 (no field changes): the quantitative 10-layer spec lives at `.personaxis/[personas/<slug>/]personaxis.md`, and the repo-root `PERSONA.md` (or `.claude/agents/<slug>.md` / `.codex/agents/<slug>.toml` in subagent mode) is now a separate, LLM-compiled qualitative document generated via `personaxis compile`.

## Schema sync rule

`cli/schema/persona.schema.json`, `cli/schema/policy.schema.json`, and `cli/schema/state.schema.json` MUST be byte-identical to their counterparts in `persona.md/schema/`. After editing any schema, copy it to the spec repo and run `diff -q` to verify zero difference.

## Template sync rule

`cli/templates/personaxis_template.md`, `cli/templates/PERSONA_template.md`, and `cli/templates/policy_template.yaml` MUST be byte-identical to `persona.md/.personaxis/personaxis_template.md`, `persona.md/PERSONA_template.md`, and `persona.md/.personaxis/policy_template.yaml`.

## Validator contract

`validate` returns one of five statuses with mapped exit codes: `PASS` (0), `PASS_WITH_WARNINGS` (0), `FAIL_SCHEMA` (1), `FAIL_POLICY` (2), `FAIL_CONCEPTUAL` (3). The universal invariants enforced in `src/schema.ts` are the load-bearing semantic checks; do not weaken them. By default, `validate` targets `.personaxis/[personas/<slug>/]personaxis.md` and also checks `manifest.json` for drift against the compiled `PERSONA.md` / `<slug>.md`.

## v0.7 canonical commands

The v0.7 CLI ships these commands beyond the v0.6 set:

| Command | Purpose |
|---|---|
| `compile [slug] [--root] [--provider <name>] [--platform <platform>]` | `personaxis.md` -> `PERSONA.md` / `<slug>.md` via the configured provider (`local \| byok \| agent \| remote`) |
| `decompile [slug] [--root] [--provider <name>]` | Hand-edited `PERSONA.md` / `<slug>.md` -> proposed `personaxis.md`, validated before writing |
| `push [slug] [--root]` | Validate, sync `personaxis.md` <-> compiled doc, and publish a new persona version |
| `pull <slug> [--version vX.Y.Z]` | Fetch a persona version's spec + compiled doc + resource bundle |
| `migrate 0.6-to-0.7 [--apply]` | Layout-only codemod: root `PERSONA.md` -> `.personaxis/personaxis.md` + `PERSONA.md` recompile |
| `config set provider <local \| byok \| agent \| remote>` | Configure the provider used by `compile`/`decompile`/self-improvement |

## v0.6 canonical commands

The v0.6 CLI ships these commands beyond the v0.5 set:

| Command | Purpose |
|---|---|
| `state init` | Create `state.json` beside `personaxis.md`, seeded from envelope means |
| `state mutate --field <path> --delta <n> --reason <text>` | Adjust a current value, clamped to envelope, with audit log |
| `state show [--json]` | Pretty-print current state |
| `migrate 0.5-to-0.6 [--apply]` | Structural codemod with written report |

Mutations are clamped to envelopes declared in `personality.traits.*`, `affect.baseline.core_affect.*`, and `affect.baseline.mood.*`. Hard-enforced virtues will eventually trigger governance blocks; the runtime version of this check is in the managed runtime, not the CLI.

## Build and test

```bash
pnpm install
pnpm run lint                # tsc --noEmit
pnpm run build               # tsc
node dist/index.js validate ../persona.md/.personaxis/personas/cmo/personaxis.md   # must return PASS
node dist/index.js state show -f ../persona.md/.personaxis/personas/cmo/state.json
```

<!-- PERSONA:BASELINE:BEGIN -->
## Behavioral Baseline

Always read @PERSONA.md at project root before acting.
Apply everything defined there to every decision, regardless of role.
Read your own @PERSONA.md too if one was provided to you.
<!-- PERSONA:BASELINE:END -->
