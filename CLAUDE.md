# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The reference CLI implementation of the **personaxis.md spec v0.10.0** (Personaxis v15). Published to npm as `@personaxis/persona.md`. The spec itself lives at [persona.md](https://github.com/personaxis/persona.md); this repo implements the validator, linter, init templates, compile/decompile, push/pull, providers, state mutation, and migration codemods.

**v0.10.0** (additive on v0.9.0; v0.9 personas validate unchanged) makes the compiled `PERSONA.md` a **persona-prompting artifact**. New OPTIONAL fields: `identity.short_name`, inline `improvement_policy.mode`, and the `persona_prompting` block (`address`, `voice_exemplars`, `scene_contracts`, `behavioral_anchors`, `break_character_guardrails`, `consistency`) — compile assembles them into a second-person, character-card + scene-contract document (methodology + citations: `persona.md/docs/PERSONA_PROMPTING.md`). Self-evolution now covers **qualitative** material under the same governance. Multi-persona: a sub-persona compiles to `.personaxis/personas/<slug>/PERSONA.md` (inside its folder), addressable in the REPL with `@slug`/`@all`, read-only across personas. Change the self-improvement posture with `personaxis improve <mode>`; migrate with `personaxis migrate 0.9-to-0.10`. Feature docs live in `docs/`. (v0.9.0 added `verification`, `agent_budget`, `observability`.)

v0.8.0 is **additive** on top of v0.7.0 (no field changes; v0.7 personas validate unchanged): new OPTIONAL fields lift runtime-governance guarantees into the spec — `identity.capabilities` (routing), `governance.max_step_delta` (per-step drift cap), a `permissions` block (per-persona sandbox posture), `mutation_log.origin_node`/`session_id` (cross-OS reconciliation), and a normative `schema/memory.schema.json` (episodic entry: provenance + hash chain). Migrate with `personaxis migrate 0.7-to-0.8`. v0.7.0 was a layout-only move: the quantitative 10-layer spec lives at `.personaxis/[personas/<slug>/]personaxis.md`, and the repo-root `PERSONA.md` (or `.claude/agents/<slug>.md` / `.codex/agents/<slug>.toml` in subagent mode) is a separate, LLM-compiled qualitative document generated via `personaxis compile`.

## Monorepo & living architecture (WIP — "personaxis")

This repo is migrating from a single CLI package into a **pnpm monorepo** that turns the CLI into a *living, governed persona agent* (see `plan/` for the full roadmap + research, and `plan/MASTER_CHECKLIST.md`).

| Package | Role |
|---|---|
| `packages/core` (`@personaxis/core`) | Framework-agnostic engine: persona/state IO, envelope extraction, **clamp+audit state engine**, appraisal signals + JSON schema, **governance gate** (locked/suggesting/autonomous), **append-only hash-chained episodic memory**, the **Living Loop** (`observe→appraise→evolve→recompile→memory`), event bus, deterministic per-persona **sigil**, heuristic + **LLM (constrained-decoding) appraisers**. |
| `packages/cli` (`@personaxis/persona.md`) | The existing CLI (validate/lint/compile/decompile/state/...) **plus** the interactive **REPL**: `personaxis` with no subcommand enters a living session (NL + `/commands`). The original `src/` moved here unchanged. |
| `packages/mcp` (`@personaxis/mcp`) | stdio **MCP server** (`personaxis-mcp`) exposing persona tools (`persona_compiled`, `persona_state`, `adjust_persona_state`, `persona_observe`, `persona_audit`, …) to any host (Claude Code, Codex, Cursor). |
| `packages/tui` | (placeholder) future ascii dashboard. |

**Build/test/run (from repo root):**
```bash
pnpm install
pnpm run build            # pnpm -r build (core first, then cli/mcp)
pnpm run test             # vitest across packages
node packages/cli/dist/index.js validate ../persona.md/.personaxis/personas/cmo/personaxis.md   # golden -> PASS
node packages/cli/dist/index.js --persona <path>   # enter the living REPL
```

**Path note:** `schema/` and `templates/` now live under `packages/cli/`. The byte-identity sync rule below still holds, but the sibling-repo relative path is now `../../../persona.md` from `packages/cli/`. The five-state validator, 12 universals, and envelope clamping are unchanged and still the source of truth.

## Three-artifact model (v0.7)

| Artifact | Mutability | Schema | Who edits |
|---|---|---|---|
| `.personaxis/[personas/<slug>/]personaxis.md` | Immutable identity (quantitative) | `schema/persona.schema.json` | Humans (or actor under `improvement_policy != locked`), via `personaxis decompile` |
| `PERSONA.md` / `.claude/agents/<slug>.md` / `.codex/agents/<slug>.toml` | Compiled identity (qualitative) | n/a (prose) | Generated via `personaxis compile`; hand-edits folded back via `personaxis decompile` |
| `state.json` | Mutable runtime | `schema/state.schema.json` | Runtime via `adjust_persona_state` tool |
| `.dist/` | Ephemeral per-request | n/a (compiled output) | The Personaxis runtime compiler (deterministic, separate from `personaxis compile`) |

## Architecture

| File | Role |
|---|---|
| `schema/persona.schema.json` | JSON Schema for personaxis.md - byte-identical to `persona.md/schema/persona.schema.json` |
| `schema/policy.schema.json` | JSON Schema for policy.yaml - byte-identical to `persona.md/schema/policy.schema.json` |
| `schema/state.schema.json` | JSON Schema for state.json - byte-identical to `persona.md/schema/state.schema.json` |
| `templates/personaxis_template.md` | Canonical quantitative scaffold - byte-identical to `persona.md/.personaxis/personaxis_template.md` |
| `templates/PERSONA_template.md` | Canonical compiled-document template - byte-identical to `persona.md/PERSONA_template.md` |
| `templates/policy_template.yaml` | Canonical policy template - byte-identical to `persona.md/.personaxis/policy_template.yaml` |
| `src/schema.ts` | Ajv schema validation + semantic universals + 5-state validator output |
| `src/policy.ts` | Sibling policy.yaml validation |
| `src/linter/rules.ts` | Lint rules (tier-aware: MUST/SHOULD/MAY) |
| `src/load.ts` | Resolves `.personaxis/[personas/<slug>/]personaxis.md` paths (root vs subagent) |
| `src/manifest.ts` | `manifest.json`: tracks compile/decompile provenance + content hashes |
| `src/resource-manifest.ts` | Builds the capped resource manifest (`memory.md`, `memory/`, `references/`, `examples/`, `skills/`, `assets/`) injected into compile/decompile prompts |
| `src/compile-instructions.ts` | Prompt templates for `compile` (forward) and `decompile` (reverse) |
| `src/providers/` | `local \| byok \| agent \| remote` provider implementations |
| `src/commands/init.ts` | Template generators |
| `src/commands/compile.ts` | `personaxis.md` -> `PERSONA.md` / `<slug>.md` (LLM, via configured provider) |
| `src/commands/decompile.ts` | `PERSONA.md` / `<slug>.md` -> proposed `personaxis.md` (LLM + validate) |
| `src/commands/push.ts` / `src/commands/pull.ts` | Publish/fetch a persona version (spec + compiled doc + resource bundle) |
| `src/commands/state.ts` | state.json init/mutate/show (envelope-clamped mutations + mutation_log) |
| `src/commands/migrate.ts` | `0.5-to-0.6` and `0.6-to-0.7` codemods with written reports |
| `src/targets/claude-code.ts` | Placement adapter: Claude Code subagent + CLAUDE.md baseline |
| `src/targets/codex.ts` | Placement adapter: Codex custom agent + AGENTS.md baseline |
| `src/targets/placement.ts` | Converts the canonical compiled document into a platform's subagent convention |
| `src/targets/skills.ts` | Resolve `extensions.skills` entries, materialize local skills to platform discovery dirs, write `skills-manifest.json` |

## Schema and template sync rule

Schemas and templates MUST be byte-identical between this repo and `persona.md/`:

```powershell
# After editing any schema or template in this repo
cp schema/persona.schema.json ../persona.md/schema/persona.schema.json
cp schema/policy.schema.json ../persona.md/schema/policy.schema.json
cp schema/state.schema.json ../persona.md/schema/state.schema.json
cp templates/personaxis_template.md ../persona.md/.personaxis/personaxis_template.md
cp templates/PERSONA_template.md ../persona.md/PERSONA_template.md
cp templates/policy_template.yaml ../persona.md/.personaxis/policy_template.yaml
diff -q schema ../persona.md/schema   # must show no differences
```

## Validator semantics

`validate` returns one of five statuses with mapped exit codes:

| Status | Exit code | Meaning |
|---|---|---|
| `PASS` | 0 | All MUST present, all universals satisfied |
| `PASS_WITH_WARNINGS` | 0 | Missing SHOULDs or NEAR-UNIVERSAL recommendations |
| `FAIL_SCHEMA` | 1 | MUST field absent or wrong type (Ajv) |
| `FAIL_POLICY` | 2 | Universal policy invariant violated |
| `FAIL_CONCEPTUAL` | 3 | Prohibited claim or wrong universal constant |

The universals enforced semantically (in `src/schema.ts`):

1. `apiVersion === "persona.dev/v1"` → FAIL_CONCEPTUAL
2. `affect.representation === "hybrid_dimensional_appraisal_discrete_mood"` → FAIL_CONCEPTUAL
3. `affect.regulation_policy.never_claim_real_feeling === true` → FAIL_CONCEPTUAL
4. `persona.constraints.cannot_claim_real_emotion === true` → FAIL_CONCEPTUAL
5. `character.virtues.honesty.enforcement === "hard"` → FAIL_POLICY
6. `values_and_drives.values.safety.weight >= 0.90` with `type: "governance"` → FAIL_POLICY
7. `values_and_drives.conflict_resolution.safety_over_completion === true` → FAIL_POLICY
8. 3 literal `reflexive_self_regulation.hard_limits` present → FAIL_POLICY
9. Edit policy for reflexive_self_regulation must be `"governance_controlled"` (v0.6: read from `governance.per_layer_edit_policy.reflexive_self_regulation`; v0.5 fallback to `reflexive_self_regulation.edit_policy`) → FAIL_POLICY
10. `persona.constraints.cannot_override_{identity,character} === true` → FAIL_POLICY
11. `memory.deletion_policy.user_request_supported === true` → FAIL_POLICY
12. `cognition.uncertainty_policy.abstain_when_above > disclose_when_above` → FAIL_POLICY

## Build and test

```bash
pnpm install
pnpm run lint                                                                          # tsc --noEmit
pnpm run build                                                                         # tsc -> dist/
node dist/index.js validate ../persona.md/.personaxis/personas/cmo/personaxis.md      # golden test -> PASS
node dist/index.js state show -f ../persona.md/.personaxis/personas/cmo/state.json
node dist/index.js state mutate -f ../persona.md/.personaxis/personas/cmo/state.json \
  --field mood.tone --delta -0.10 --reason "smoke test"                               # envelope clamp test
node dist/index.js migrate 0.5-to-0.6 some-old-PERSONA.md                              # dry-run codemod
node dist/index.js migrate 0.6-to-0.7                                                  # layout-only codemod (PERSONA.md -> .personaxis/)
node dist/index.js compile --root                                                      # .personaxis/personaxis.md -> PERSONA.md
node dist/index.js decompile --root                                                    # PERSONA.md -> proposed .personaxis/personaxis.md
```

The golden test is the CMO example at `../persona.md/.personaxis/personas/cmo/personaxis.md` in the sibling `persona.md/` repo. If `validate` returns anything other than `PASS`, the spec or the validator drifted.

## v0.6 envelope clamping

The state mutation pipeline (`src/commands/state.ts`) reads envelopes from PERSONA.md:

- `personality.traits.<name>.{mean, range}`
- `affect.baseline.core_affect.<dim>.{mean, range}`
- `affect.baseline.mood.<dim>.{mean, range}`

Mutations via `state mutate` are clamped to the declared range. The mutation_log records `clamped: true` whenever the requested delta would have exceeded the envelope. The Interstellar humor knob problem is resolved by this clamping.

Hard-enforced virtue mutation gating is partially implemented (governance_blocked field reserved). The full check is the managed runtime's responsibility; the CLI handles the envelope check only.

## Adding a new spec field

Every field addition or removal must update all of:

1. `schema/persona.schema.json` (this repo) and copy to `persona.md/schema/`
2. `src/schema.ts` if the field has a universal invariant
3. `src/linter/rules.ts` if there is a tier-specific lint check
4. `src/commands/init.ts` - every template builder that should include the field
5. `src/compile-instructions.ts` and `src/targets/placement.ts` if the field affects compiled output
6. `persona.md/docs/SPEC.md` - the normative spec doc
7. `persona.md/.personaxis/personaxis_template.md` - the canonical quantitative scaffold with tier and consumer tag comments
8. `persona.md/.personaxis/personas/cmo/personaxis.md` - a real value (then regenerate `persona.md/PERSONA.md` via `personaxis compile --root`)
9. `persona.md/CHANGELOG.md` - under `[Unreleased]` or current version

<!-- PERSONA:BASELINE:BEGIN -->
## Behavioral Baseline

Always read @PERSONA.md at project root before acting.
Apply everything defined there to every decision, regardless of role.
Read your own @PERSONA.md too if one was provided to you.

The persona file conforms to the PERSONA.md spec. It defines ten canonical layers (identity, character, personality, values_and_drives, affect, cognition, memory, metacognition, reflexive_self_regulation, persona) plus governance and security. The reflexive_self_regulation.hard_limits are absolute and never crossed.
<!-- PERSONA:BASELINE:END -->
