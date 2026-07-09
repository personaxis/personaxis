# @personaxis/persona.md

> **This version has not been published to npm yet.** The code in this repository is ahead of the latest npm release. To use the latest published version run `npx @personaxis/persona.md`. To use this unreleased version, clone the repo and run `pnpm install && pnpm run build && node dist/index.js`.

[![npm](https://img.shields.io/npm/v/@personaxis%2Fpersona.md)](https://www.npmjs.com/package/@personaxis/persona.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Spec](https://img.shields.io/badge/spec-1.1.0-informational)](https://github.com/personaxis/persona.md/blob/main/docs/SPEC.md)

**The portable, governed, _proven_ persona layer that lives above every model.** Define an AI persona once — all 10 layers, not just a name and a vibe — in plain git-versionable files, run it unchanged on Claude, GPT, Gemini, or a local model, and get **mathematical guarantees** that it cannot drift outside what you declared:

- **It can't escape.** Every mutable value lives in a declared envelope; no adversarial input sequence can leave it (theorem T1, verified against **2.3M generated adversarial cases, 0 counterexamples** — [`docs/GUARANTEES.md`](docs/GUARANTEES.md)).
- **Change is forensic.** Crossing into different behavior costs a provable minimum of hash-chained audit entries (T3); history replays deterministically and tampering is located, not just detected (T4/T5).
- **Created from anything, grounded in evidence.** `personaxis create` builds a valid-by-construction persona from an interview, a prompt, your repo, a character card, or transcripts — with a creation report giving the provenance of every number.

See it hold in 60 seconds, offline:

```bash
npx @personaxis/persona.md proof --quick
```

CLI for [PERSONA.md](https://github.com/personaxis/persona.md) -- create, define, validate, lint, compile, decompile, edit, push, pull, and migrate AI agent personas (spec v1.1.0). Personas at 0.3.0–1.0.0 still validate unchanged.

Full documentation lives in the [PERSONA.md spec repository](https://github.com/personaxis/persona.md); guarantees: [`docs/GUARANTEES.md`](docs/GUARANTEES.md); the formal core: [`docs/MATH_CORE.md`](docs/MATH_CORE.md); guides: [`docs/guides/`](docs/guides/).

---

## Living persona (new)

**Play in 60 seconds** — run `personaxis` in any empty folder:

```bash
personaxis                       # first run scaffolds a valid starter persona, then it wakes up
# › hi! talk in natural language, or use /state /drift /audit /memory /persona ...
```

It creates a valid, playable companion (`.personaxis/personaxis.md`), the persona **awakens** with its own animated sigil, and **replies** to you. For a real conversation, point it at a model:

```bash
export PERSONAXIS_ENDPOINT=http://localhost:11434/v1   # Ollama / llama.cpp
export PERSONAXIS_MODEL=qwen3:4b
```

Beyond the REPL, `personaxis` is a **living, governed persona agent**. Drive an existing persona directly:

```bash
node packages/cli/dist/index.js --persona .personaxis/personaxis.md
# › talk in natural language, or use /state /drift /arbitrate /replay /audit /memory /persona ...
```

Each turn feeds a **governed Living Loop** — `observe → appraise → evolve → recompile → memory` — where every state change is **clamped to the persona's envelopes, audited in an immutable mutation log, and reversible**, and episodic memory is written to an **append-only hash chain** (tamper/poisoning-evident). Identity stays immutable; only `state.json` and memory evolve, within the spec's universal invariants.

Set a local model for the appraisal step (constrained decoding keeps even a ≤4B model safe):

```bash
export PERSONAXIS_ENDPOINT=http://localhost:11434/v1   # Ollama / llama.cpp
export PERSONAXIS_MODEL=qwen3:4b
```

**Use it inside a bigger agent (Claude Code, Codex, Cursor)** via the MCP server — the host brings the powerful model, personaxis brings the living identity:

```bash
personaxis-mcp     # stdio MCP server: persona_compiled, persona_state,
                   # adjust_persona_state, persona_observe, persona_audit, ...
```

This repo is a **pnpm monorepo** of eight lockstep packages (`@personaxis/spec`, `core`, `protocol`, `persona.md` [the CLI], `mcp`, `sdk`, `evals`, `tui`).

**📖 How it works:** [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md) — what personaxis is, the three-artifact model, the governed Living Loop, the security model, the full command reference, and the architecture. See [`plan/`](plan/) for the roadmap + research dossier and [`plan/14-apa-report/REPORT.md`](plan/14-apa-report/REPORT.md) for the APA report.

---

## Quick start

```bash
npx @personaxis/persona.md init
npx @personaxis/persona.md validate
npx @personaxis/persona.md lint
npx @personaxis/persona.md compile --root                              # root persona -> PERSONA.md
npx @personaxis/persona.md compile <slug> --platform claude-code      # subagent -> .claude/agents/<slug>.md
npx @personaxis/persona.md compile <slug> --platform codex            # subagent -> .codex/agents/<slug>.toml
```

Migrate an existing persona:

```bash
npx @personaxis/persona.md migrate 0.5-to-0.6 ./PERSONA.md --apply   # v0.5 -> v0.6 structural codemod
npx @personaxis/persona.md migrate 0.6-to-0.7 --apply                # v0.6 layout -> v0.7 layout
npx @personaxis/persona.md migrate 0.7-to-0.8 --apply                # v0.7 -> v0.8 (additive: spec_version bump)
npx @personaxis/persona.md migrate 0.10-to-1.0 --apply               # v0.10 -> v1.0 (stable spec; breaking, comment-preserving)
```

Mutate runtime state (clamped to envelopes declared in personaxis.md):

```bash
npx @personaxis/persona.md state init                                  # seed state.json from envelope means
npx @personaxis/persona.md state mutate --field mood.tone --delta -0.10 --reason "less playful"
npx @personaxis/persona.md state show
```

Requires Node.js 18+.

---

## Commands

| Command | Description |
|---|---|
| `init` | Create a PERSONA.md interactively (project baseline, AgentPersona, or UserPersona) |
| `init --agent` | Create a role-specific AgentPersona in `.personaxis/personas/<slug>/` |
| `init --user` | Create a UserPersona representing the human user |
| `validate` | Schema + universals validation. Returns one of `PASS`, `PASS_WITH_WARNINGS`, `FAIL_SCHEMA`, `FAIL_POLICY`, `FAIL_CONCEPTUAL`. Validates sibling `policy.yaml` (v0.5+) and `state.json` (v0.6+). |
| `lint` | Semantic lint with structured findings (errors, warnings, info) |
| `compile [<slug>] [--root] [--platform <p>]` | Compile `personaxis.md` to `PERSONA.md` (root) or `<slug>.md` (subagent) via the configured provider |
| `decompile [<slug>] [--root]` | Hand-edited `PERSONA.md`/`<slug>.md` -> proposed `personaxis.md` (LLM + validate) |
| `export --format json\|md\|yaml` | Export personaxis.md as clean semantic content |
| `template list\|show\|get` | Manage pedagogical templates |
| `diff <before> <after>` | Compare two versions field by field |
| `spec` | Print the v1.1.0 spec — useful for injecting into agent prompts |
| `use <template>` | Scaffold a persona from a template |
| `list` | List personas installed in this project |
| `templates` | List built-in templates |
| **`state init`** | **v0.6:** Create `state.json` beside PERSONA.md, seeded from envelope means |
| **`state mutate`** | **v0.6:** Adjust a current value (clamped to envelope, logged to mutation_log) |
| **`state show`** | **v0.6:** Pretty-print current state, active context, and recent mutations |
| **`migrate 0.5-to-0.6`** | **v0.6:** Apply structural codemod (folder renames, governance unification, etc.) with a written report |
| **`push [--root\|<slug>]`** | **v0.7.0:** Validate, decompile if `PERSONA.md`/`<slug>.md` was hand-edited, recompile, and upload a new `AgentPersonaVersion` |
| **`pull [--root\|<slug>]`** | **v0.7.0:** Download a persona version (spec, compiled document, and support folders) into the local layout |
| **`skills list [--root\|<slug>]`** | **v0.7.0:** List `extensions.skills` entries and their materialization status (`materialized`, `missing-local`, `reference-only`) |
| **`skills pull <name> [--root\|<slug>]`** | **v0.7.0:** Pull a `github:org/repo[/path]` skill entry into `skills/<name>/`, validate it against agentskills.io rules, and offer to rewrite the `extensions.skills` entry to `./skills/<name>` |
| **`migrate 0.7-to-0.8`** | **v0.8.0:** Additive bump (no field changes); makes the new optional fields available |
| **(no subcommand)** | **v0.8.0:** Enter the living **REPL** — talk to your persona; it replies and evolves via the governed Living Loop. First run scaffolds a valid starter persona |
| **`sigil [--persona <p>]`** | **v0.8.0:** Render a persona's deterministic, state-aware ASCII sigil + envelope panel |
| **`overseer show\|register\|collection`** | **v0.8.0:** The master view — all personas, projects, and **collections** (taxonomy) |
| **`team create\|add\|goal\|show`** | **v0.8.0:** Operational multi-agent **teams** (roles + lead + shared goal) — distinct from collections |
| **`orchestrate "<task>" [--team <name>] [--run]`** | **v0.8.0:** Route a task to the best-matching persona via the capability blackboard |
| **`sync <other-state.json> --persona <p>`** | **v0.8.0:** Reconcile a portable persona's `state.json` across machines (no clobber) |
| **`serve --persona <p>`** | **v0.8.0:** Serve a persona over HTTP + `agents.md` (low-context interop for any agent) |
| **`edit <dot-path> <value>`** | **v1.0:** Surgical, governed single-leaf edit — re-validates and refuses any edit that would break a universal (`--force`, `--dry-run`) |
| **`state rebuild`** | **v1.0:** Replay the mutation_log to rebuild/repair `state.json` as a derived checkpoint (drift detection; `--write`) |
| **`dash [--persona <p>]`** | **v1.0:** Live ASCII dashboard (Ink) — sigil, envelopes, and chain, reflecting evolution in real time |
| **`migrate 0.10-to-1.0`** | **v1.0:** Codemod to the stable spec (layer-9 rename, `persona_prompting`→`persona`, refusal-surface fold, memory knobs→`runtime`, dot-path state keys) |
| **`create [slug]`** | **v1.1:** Persona Genesis — interview / `--from-prompt` / `--from-project` / `--from-import` (cards V2/V3, system prompts) / `--from-transcript` → valid-by-construction spec + creation report with per-number provenance |
| **`proof [--quick] [--auto]`** | **v1.1:** Watch the guarantees hold, offline: adversarial storm (0 escapes), certified band-crossing cost, tamper located, deterministic replay |
| **`state drift`** | **v1.1:** Per-coordinate `u`/band/headroom + T3 evidence cost; layer `D` vs `governance.drift_thresholds` (exit 2 past tolerance — CI gate) |
| **`jacobian`** | **v1.1:** Exact compile-sensitivity per coordinate (σ); flags provably decorative numbers (exit 2) |
| **`arbitrate [a] [b]`** | **v1.1:** Deterministic value-conflict resolution with a trace (`governance` ≻ `weight` ≻ name; safety-beats-completion is a theorem) |

### Validate exit codes

| Status | Exit | Meaning |
|---|---|---|
| `PASS` | 0 | All MUST present and all universals satisfied |
| `PASS_WITH_WARNINGS` | 0 | Valid but missing SHOULDs or NEAR-UNIVERSAL recommendations |
| `FAIL_SCHEMA` | 1 | MUST field absent or wrong type |
| `FAIL_POLICY` | 2 | A universal policy invariant violated |
| `FAIL_CONCEPTUAL` | 3 | Prohibited claim or wrong universal constant |

See [github.com/personaxis/persona.md](https://github.com/personaxis/persona.md) for the full CLI reference, lint rules, programmatic API, and examples.

### Compile platforms

| Platform | Root output | Subagent output | Skills |
|---|---|---|---|
| `claude-code` | `PERSONA.md` (+ `CLAUDE.md` baseline injection) | `.claude/agents/<slug>.md` | Local skills materialized to `.claude/skills/<name>/` |
| `codex` | `PERSONA.md` (+ `AGENTS.md` baseline injection) | `.codex/agents/<slug>.toml` | Local skills materialized to `.agents/skills/<name>/` |
| `cursor` | `.cursor/rules/persona.mdc` | — | Archived |
| `soul-md` | `SOUL.md` | — | Archived |

Compile is LLM-based (via the configured provider). Edit `.personaxis/[personas/<slug>/]personaxis.md`, then recompile; do not edit `PERSONA.md`, `.claude/agents/`, `.codex/agents/`, or materialized skills directly (use `personaxis decompile` to fold hand-edits back into the spec).

---

## Skills (`extensions.skills`, v0.7.0)

`extensions.skills` is an index, not a content host. Each entry resolves to a folder
with a `SKILL.md` (agentskills.io format - frontmatter `name`/`description` + body):

```yaml
extensions:
  skills:
    - "./skills/quarterly-planning"   # local -> skills/quarterly-planning/SKILL.md
    - "@org/name@1.2.0"               # registry -> reference-only
    - "github:org/repo/path/to/skill" # github -> pullable
```

`personaxis compile [slug] --platform <platform>` materializes every `local` entry
into the target platform's skill-discovery directory (`.claude/skills/<name>/` for
`claude-code`, `.agents/skills/<name>/` for `codex`), marks each copy with
`.personaxis-generated`, and writes `skills-manifest.json` next to `personaxis.md`
recording each entry's `status` (`materialized`, `missing-local`, `reference-only`).
For Claude Code subagents, materialized local skills are also added to the compiled
`.claude/agents/<slug>.md` frontmatter `skills:` list (preload).

```bash
npx @personaxis/persona.md skills list [--root|<slug>]
npx @personaxis/persona.md skills pull <name> [--root|<slug>] [-y]
```

`skills pull` only supports `github:org/repo[/path]` entries: it does a shallow,
sparse clone, validates `SKILL.md` against agentskills.io rules, copies it to
`skills/<name>/`, and (with confirmation) rewrites the `extensions.skills` entry to
`./skills/<name>` so the next `compile` materializes it like any local skill.

---

## Three-artifact model

A persona package contains these primary artifacts:

| Artifact | Role | Mutability |
|---|---|---|
| `.personaxis/[personas/<slug>/]personaxis.md` | Immutable identity (quantitative 10-layer spec) | Only via versioned change or `improvement_policy.mode != locked`, via `personaxis decompile` |
| `PERSONA.md` / `.claude/agents/<slug>.md` | LLM-compiled qualitative document (what a coding agent reads) | Generated via `personaxis compile`; hand-edits folded back via `personaxis decompile` |
| `state.json` | Mutable runtime state (current trait/affect/mood values) | Via `state mutate` (CLI) or `adjust_persona_state` tool (runtime) |
| `policy.yaml` | Observability + improvement_policy | Edited by ops/SRE; never inlined into actor prompt |

State mutations are clamped to envelopes (`{mean, range}`) declared in `personaxis.md`. The mutation log in `state.json#/mutation_log` records every change with timestamp, actor, reason, and whether the runtime clamped or governance blocked the request.

---

## License

MIT.
