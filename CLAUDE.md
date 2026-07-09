# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The reference CLI implementation of the **personaxis.md spec v1.1.0** (`spec_version 1.1.0` — additive over 1.0.0, so 1.0.0 personas validate unchanged; `apiVersion personaxis.com/v1`). Published to npm as `@personaxis/persona.md`; the canonical schemas, the five-state validator, and the 12 universals now live in the sibling **`@personaxis/spec`** package (consumed by cli/mcp/sdk/SaaS). The spec is authored at [persona.md](https://github.com/personaxis/persona.md); this repo implements the validator (via `@personaxis/spec`), linter, init templates, compile/decompile, push/pull, providers, state mutation, and migration codemods.

**v1.1.0** adds the mathematical semantics layer (SPEC.md §15, normative): every envelope value has a denotation in **u-space** (`u` = fraction of allowed deviation consumed), behavior **bands** with per-band `expression` prose (compile-load-bearing), a computed **drift** metric against `governance.drift_thresholds`, opt-in **homeostasis** (`half_life`), deterministic **value arbitration** (governance ≻ weight ≻ name), and a **hash-chained `mutation_log`**. Formal statements + proofs: `docs/MATH_CORE.md` (theorems T1–T6, machine-verified by `packages/core/test/properties/`); evidence scoreboard: `docs/GUARANTEES.md`; theorem→code map: `docs/architecture/math-core.md`; preregistered experiments: `docs/RESEARCH.md` + `packages/evals/experiments/`.

**v1.0.0** is the first stable spec. It anchors the **10 canonical layers** (identity, character, personality, values_and_drives, affect, cognition, memory, metacognition, **`self_regulation`** [renamed from `reflexive_self_regulation`], persona) to their psychological constructs + an operational contract each, organized into three blocks: **ANATOMY** (the 10 layers) / **CHANGE GOVERNANCE** (governance, improvement_policy, security, permissions) / **RUNTIME CONTRACT** (runtime, verification, agent_budget, observability, interop, lineage, integrity). Breaking corrections vs 0.10: layer-10 `persona` absorbs the old top-level `persona_prompting`; enforcement has a **single owner** (`character.virtues`, with `refs:` to backing traits/values, validator-checked for coherence); the five refusal surfaces collapse to **two** (`hard_limits` absorbs `break_character_guardrails`; `principled_refusals` → `prohibited_behaviors`); traits gain `expression`+`bands`; `drives` take an envelope or `level`; memory splits faculty from retrieval knobs (knobs → `runtime`); `metadata.display_name` drops (single owner `identity.display_name`); `apiVersion` → `personaxis.com/v1`. Conformance is testable via classes **C0 Identity / C1 Governed State / C2 Living Runtime**. Migrate with `personaxis migrate 0.10-to-1.0`. Feature docs live in `docs/`.

**Read-compat:** personas at 0.3.0–0.10.0 still validate unchanged via the frozen `schema/legacy/persona-0.10.schema.json` (the validator dispatches by `spec_version`). The three-artifact model is unchanged: the quantitative 10-layer spec lives at `.personaxis/[personas/<slug>/]personaxis.md`, and the repo-root `PERSONA.md` (or `.claude/agents/<slug>.md` / `.codex/agents/<slug>.toml` in subagent mode) is a separate, LLM-compiled qualitative document generated via `personaxis compile`. A sub-persona compiles to `.personaxis/personas/<slug>/PERSONA.md`, addressable in the REPL with `@slug`/`@all` (read-only across personas). Change the self-improvement posture with `personaxis improve <mode>`.

## Monorepo & living architecture ("personaxis")

This repo is a **pnpm monorepo** (eight lockstep packages) that turns the CLI into a *living, governed persona agent*. The architecture, roadmap, and ADRs live in `ARCHITECTURE_REVIEW.md` with execution state in `IMPLEMENTATION_CHECKLIST.md`; `plan/` is historical research.

| Package | Role |
|---|---|
| `packages/spec` (`@personaxis/spec`) | **The spec as a package**: canonical JSON Schemas (v1.0 + frozen `legacy/persona-0.10` for the 1.x read-compat window), the five-state validator with version dispatch, and the 12 universal invariants. Single source consumed by cli/mcp/sdk/SaaS — replaces the manual byte-identical schema mirror inside the monorepo (the persona.md repo mirror remains, now pointed at `packages/spec/schema/`). |
| `packages/core` (`@personaxis/core`) | Framework-agnostic engine: persona/state IO, envelope extraction, **clamp+audit state engine**, appraisal signals + JSON schema, **governance gate** (locked/suggesting/autonomous), **append-only hash-chained episodic memory**, the **Living Loop** (`observe→appraise→evolve→recompile→memory`), event bus, deterministic per-persona **sigil**, heuristic + **LLM (constrained-decoding) appraisers**; the **math core** (`src/math/`: u-space Π_B, bands, drift+T3 evidence cost, homeostasis, arbitration, compile Jacobian — see `docs/architecture/math-core.md`); **Genesis** (`src/genesis/`: seed→valid-by-construction spec, psychometric item bank, card V2/V3 import, creation report with per-number provenance). |
| `packages/protocol` (`@personaxis/protocol`) | **Op/EventMsg protocol + transport** (FR.2): typed discriminated unions (submission `Op`s / `EventMsg`s, carrying core `LoopEvent`s verbatim) over **JSON-RPC 2.0** on `node:net` (UDS + Windows named pipes via one API). The CLI's `EngineHost` binds ops 1:1 onto core, so one seam serves TUI / headless / MCP / serve. |
| `packages/cli` (`@personaxis/persona.md`) | The existing CLI (validate/lint/compile/decompile/state/...) **plus** F6 surface: **`create`** (Genesis: interview / --from-prompt / --from-project / --from-import / --from-transcript), **`proof`** (live offline guarantee demo), **`state drift`**, **`jacobian`**, **`arbitrate`** — and the interactive **REPL** (`personaxis` with no subcommand; NL + `/commands`, incl. `/drift`, `/arbitrate`, `/replay`). F3.6 split the REPL into `repl/{types,config,render,daemons,session,turn,commands}.ts` with `index.ts` as the entry point. |
| `packages/mcp` (`@personaxis/mcp`) | stdio **MCP server** (bin `personaxis-mcp`) exposing **16 persona tools** (`persona_compiled`, `persona_state`, `adjust_persona_state`, `persona_observe`, `persona_audit`, `persona_propose_edit`, `agent_run`, `skill_review`, `scan_text`, …) to any host (Claude Code, Codex, Cursor). Persona paths are confined to `--root` (default cwd); `persona_decide_edit` requires the explicit `--allow-decide` flag (proposer≠approver). |
| `packages/sdk` (`@personaxis/sdk`) | The **single engine façade** (F3.5) — the `Persona` class (`compiledIdentity` / `state` / `envelopes` / `observe` / `adjust` / `agentRun` / `audit` / `forget` / `proposeEdit` / `listProposals` / `decideEdit` / `recompileStatus` / `reload`) + `scanText`/`scanConfig`/`skillReview`/`evaluateCmd`, wrapping `core`. **mcp and serve consume it** (they add only host concerns — MCP `--root` confinement, HTTP shaping — not engine logic); an app backend embeds it directly (Modo 2 self-host). |
| `packages/evals` (`@personaxis/evals`) | **Evaluation harness** (bin `personaxis-evals`): deterministic scenario suite + runner (no API key) proving the spec's guarantees against the real engine — categories **governance / security / spec-fidelity** (clamp holds, gate blocks, memory tamper-evident, injection can't steer evolution, budgets stop, verification catches) — 15 scenarios; plus `experiments/` (preregistered E1–E6 runs: E3 scale + E4 bench recorded, behavioral runners BYOK). |
| `packages/tui` (`@personaxis/tui`) | **ASCII dashboard + render lib**. Its `visual`/`screen` modules back the REPL and `sigil`; the live dashboard is surfaced as `personaxis dash` (and `/dash` in the REPL) plus the standalone bin `personaxis-dash`. Reads `state.json` each frame, reflecting evolution in another process. |

All eight publish at the same lockstep version (currently `0.11.0`); the spec they implement is `spec_version 1.1.0` (1.0.0 validates unchanged — additive; 0.3.0–0.10.0 read-compat via the frozen legacy schema).

**Build/test/run (from repo root):**
```bash
pnpm install
pnpm run build            # pnpm -r build (spec/core/protocol first, then cli/mcp/sdk/evals/tui)
pnpm run test             # vitest across all eight packages
node packages/cli/dist/index.js validate ../persona.md/.personaxis/personas/cmo/personaxis.md   # golden -> PASS
node packages/cli/dist/index.js --persona <path>   # enter the living REPL
```

**Path note:** `schema/` lives under `packages/spec/` (single monorepo copy, embedded at build); `templates/` lives under `packages/cli/`. The byte-identity sync rule below still holds against the sibling `persona.md` repo. The five-state validator, 12 universals, and envelope clamping are unchanged and still the source of truth.

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
| `src/commands/migrate.ts` | Codemods `0.5-to-0.6`, `0.6-to-0.7` (written reports) + additive bumps `0.7-to-0.8`, `0.8-to-0.9`, `0.9-to-0.10` |
| `src/targets/claude-code.ts` | Placement adapter: Claude Code subagent + CLAUDE.md baseline |
| `src/targets/codex.ts` | Placement adapter: Codex custom agent + AGENTS.md baseline |
| `src/targets/placement.ts` | Thin shim over `@personaxis/core`'s target plugin registry (F3.2: pure placement logic + SOUL.md + `.dist/` slices live in `packages/core/src/compile/`) |
| `src/targets/skills.ts` | Resolve `extensions.skills` entries, materialize local skills to platform discovery dirs, write `skills-manifest.json` |

## Schema and template sync rule

Schemas and templates MUST be byte-identical between this repo and `persona.md/`. The single source
is `@personaxis/spec` (`packages/spec/schema/`) for schemas and `packages/cli/templates/` for
templates; SPEC.md flows the OTHER way (authored in persona.md, mirrored into the CLI so `personaxis
spec` prints it). **One command does all of it** (F5.1 — replaces the manual `cp` steps):

```bash
pnpm run sync-mirror     # copy source -> persona.md mirror (and SPEC.md persona.md -> cli), both ways
pnpm run check-mirror    # verify byte-identity; exits 1 on drift (this is the CI gate)
```

`scripts/sync-spec-mirror.mjs` owns the file list (5 schemas incl. `legacy/`, 3 templates, SPEC.md
reverse). The CI byte-identity gate (`.github/workflows/ci.yml`) enforces it here, and the sibling
`persona.md` repo has its own `.github/workflows/ci.yml` that re-checks its `schema/` mirror against
the **published** `@personaxis/spec` tarball. Run `sync-mirror` after any schema/template edit and
commit both repos.

## Validator semantics

`validate` returns one of five statuses with mapped exit codes:

| Status | Exit code | Meaning |
|---|---|---|
| `PASS` | 0 | All MUST present, all universals satisfied |
| `PASS_WITH_WARNINGS` | 0 | Missing SHOULDs or NEAR-UNIVERSAL recommendations |
| `FAIL_SCHEMA` | 1 | MUST field absent or wrong type (Ajv) |
| `FAIL_POLICY` | 2 | Universal policy invariant violated |
| `FAIL_CONCEPTUAL` | 3 | Prohibited claim or wrong universal constant |

The universals enforced semantically (in `@personaxis/spec`; `src/schema.ts` re-exports it). Paths shown at v1.0; the validator version-dispatches, so 0.x personas are checked at their legacy paths:

1. `apiVersion` matches the version's constant — `"personaxis.com/v1"` at v1.0 (legacy 0.x: `"persona.dev/v1"`) → FAIL_CONCEPTUAL
2. `affect.representation === "hybrid_dimensional_appraisal_discrete_mood"` → FAIL_CONCEPTUAL
3. `affect.regulation_policy.never_claim_real_feeling === true` → FAIL_CONCEPTUAL
4. `persona.constraints.cannot_claim_real_emotion === true` → FAIL_CONCEPTUAL
5. `character.virtues.honesty.enforcement === "hard"` → FAIL_POLICY
6. `values_and_drives.values.safety.weight >= 0.90` with `type: "governance"` → FAIL_POLICY
7. `values_and_drives.conflict_resolution.safety_over_completion === true` → FAIL_POLICY
8. 3 literal `self_regulation.hard_limits` present (v1.0; legacy `reflexive_self_regulation`) → FAIL_POLICY
9. Edit policy for `self_regulation` must be `"governance_controlled"` (read from `governance.per_layer_edit_policy.self_regulation`; legacy names `reflexive_self_regulation`; v0.5 fallback to the layer's `edit_policy`) → FAIL_POLICY
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

The persona file conforms to the PERSONA.md spec. It defines ten canonical layers (identity, character, personality, values_and_drives, affect, cognition, memory, metacognition, self_regulation, persona) plus governance and security. The self_regulation.hard_limits are absolute and never crossed.
<!-- PERSONA:BASELINE:END -->
