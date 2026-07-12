# AGENTS.md

Instructions for AI agents working on the `personaxis` CLI repository.

## What this repo is

The reference CLI implementation of the [personaxis.md spec v1.0.0](https://github.com/personaxis/persona.md) (`spec_version 1.0.0`, `apiVersion personaxis.com/v1`). Published to npm as `personaxis`; it is one of eight lockstep packages in this pnpm monorepo. See `CLAUDE.md` for the full package map and the v1.0 layer model.

The quantitative 10-layer spec lives at `.personaxis/[personas/<slug>/]personaxis.md`, and the repo-root `PERSONA.md` (or `.claude/agents/<slug>.md` / `.codex/agents/<slug>.toml` in subagent mode) is a separate, LLM-compiled qualitative document generated via `personaxis compile`. Personas at 0.3.0–0.10.0 still validate unchanged (the validator dispatches by `spec_version` to a frozen legacy schema).

## Schema sync rule

The canonical schemas live in **`packages/spec/schema/`** (`persona.schema.json`, `policy.schema.json`, `state.schema.json`, `memory.schema.json`, `legacy/persona-0.10.schema.json`) and MUST be byte-identical to their counterparts in `persona.md/schema/`. After editing any schema, copy it to the spec repo and run `diff -qr packages/spec/schema ../persona.md/schema` to verify zero difference (see `CLAUDE.md` → "Schema and template sync rule").

## Template sync rule

`packages/cli/templates/personaxis_template.md`, `packages/cli/templates/PERSONA_template.md`, and `packages/cli/templates/policy_template.yaml` MUST be byte-identical to `persona.md/.personaxis/personaxis_template.md`, `persona.md/PERSONA_template.md`, and `persona.md/.personaxis/policy_template.yaml`.

## Validator contract

`validate` returns one of five statuses with mapped exit codes: `PASS` (0), `PASS_WITH_WARNINGS` (0), `FAIL_SCHEMA` (1), `FAIL_POLICY` (2), `FAIL_CONCEPTUAL` (3). The five-state validator + 12 universal invariants live in **`@personaxis/spec`** (`packages/cli/src/schema.ts` re-exports them); they are the load-bearing semantic checks, do not weaken them. By default, `validate` targets `.personaxis/[personas/<slug>/]personaxis.md` and also checks `manifest.json` for drift against the compiled `PERSONA.md` / `<slug>.md`.

## Canonical commands (v1.0)

Beyond `validate`/`lint`/`init`:

| Command | Purpose |
|---|---|
| `personaxis` (no subcommand) | Enter the living **REPL** (chat + `/commands`); first run scaffolds a valid starter persona |
| `compile [slug] [--root] [--provider <name>] [--platform <platform>] [--no-polish]` | `personaxis.md` -> `PERSONA.md` / `<slug>.md`, deterministic assembler + optional faithfulness-gated LLM polish |
| `decompile [slug] [--root] [--provider <name>]` | Hand-edited compiled doc -> proposed `personaxis.md`, validated before writing |
| `edit <dot-path> <value> [--force] [--dry-run]` | Surgical, governed single-leaf edit (re-validates; refuses universal-breaking edits) |
| `state init\|show\|mutate\|rebuild` | `state.json` lifecycle; `mutate` clamps to envelopes + governance gate; `rebuild` replays the mutation_log |
| `push [slug] [--root]` / `pull <slug> [--version vX.Y.Z]` | Publish / fetch a persona version (spec + compiled doc + resource bundle) |
| `migrate 0.10-to-1.0 [--apply]` | Codemod to v1.0 (earlier codemods `0.5-to-0.6` … `0.9-to-0.10` remain available) |
| `improve <mode>` | Set the self-improvement posture (`locked` / `suggesting` / `autonomous`) |
| `dash` / `serve --persona <p>` | Live ASCII dashboard / HTTP interop server |
| `config set provider <local \| byok \| agent \| remote>` | Provider used by `compile`/`decompile`/self-improvement |

Mutations are clamped to envelopes declared in `personality.traits.*`, `affect.baseline.core_affect.*`, and `affect.baseline.mood.*`; in `locked`/non-human contexts the governance gate blocks out-of-policy mutations, and hard-enforced virtues are immutable for everyone.

## Build and test

```bash
pnpm install
pnpm run lint                # tsc --noEmit across the workspace
pnpm run build               # pnpm -r build
node packages/cli/dist/index.js validate ../persona.md/.personaxis/personas/cmo/personaxis.md   # must return PASS
node packages/cli/dist/index.js state show -f ../persona.md/.personaxis/personas/cmo/state.json
```

<!-- PERSONA:BASELINE:BEGIN -->
## Behavioral Baseline

Always read @PERSONA.md at project root before acting.
Apply everything defined there to every decision, regardless of role.
Read your own @PERSONA.md too if one was provided to you.

The persona file conforms to the PERSONA.md spec: ten canonical layers (identity, character, personality, values_and_drives, affect, cognition, memory, metacognition, self_regulation, persona) plus governance and security. The self_regulation.hard_limits are categorical absolutes and are never crossed.
<!-- PERSONA:BASELINE:END -->
