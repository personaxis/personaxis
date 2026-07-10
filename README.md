# @personaxis/persona.md

> **Two ways to use this**: install the official release from npm, or run the newest code from a clone: see [Install & run](#install--run-two-paths).

[![npm](https://img.shields.io/npm/v/@personaxis%2Fpersona.md)](https://www.npmjs.com/package/@personaxis/persona.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Spec](https://img.shields.io/badge/spec-1.1.0-informational)](https://github.com/personaxis/persona.md/blob/main/docs/SPEC.md)

**The portable, governed, _proven_ persona layer that lives above every model.** Define an AI persona once (all 10 layers, not just a name and a vibe) in plain git-versionable files, run it unchanged on Claude, GPT, Gemini, or a local model, and get **mathematical guarantees** that it cannot drift outside what you declared:

- **It can't escape.** Every mutable value lives in a declared envelope; no adversarial input sequence can leave it (theorem T1, verified against **2.3M generated adversarial cases, 0 counterexamples**: [`docs/GUARANTEES.md`](docs/GUARANTEES.md)).
- **Change is forensic.** Pushing behavior away from its declared baseline costs a provable minimum of hash-chained audit entries (T3); history replays deterministically and tampering is located, not just detected (T4/T5).
- **Created from anything, grounded in evidence.** `personaxis create` builds a valid-by-construction persona from an interview, a prompt, your repo, a character card, or transcripts, with a creation report giving the provenance of every number.

Full documentation lives in the [PERSONA.md spec repository](https://github.com/personaxis/persona.md); guarantees: [`docs/GUARANTEES.md`](docs/GUARANTEES.md); the formal core: [`docs/MATH_CORE.md`](docs/MATH_CORE.md); guides: [`docs/guides/`](docs/guides/).

---

## Install & run: two paths

**Path 1 · Users (official releases, npm).** For using personaxis directly, no clone:

```bash
npm i -g @personaxis/persona.md
personaxis proof --quick     # 60 s, offline: watch the guarantees hold before trusting them
```

> The published version lags this repo until the next lockstep release (0.12.0) ships;
> `create`, `proof`, `state drift`, `jacobian`, and `arbitrate` need 0.12.0. Check with
> `personaxis --version`; if npm still serves an older version, use Path 2 today.

**Path 2 · Developers (from source).** For hacking on personaxis, or for the newest
features before they're published (Node 18+, pnpm):

```bash
git clone https://github.com/personaxis/cli && cd cli
pnpm install
pnpm run build                        # builds the 8 packages
cd packages/cli && npm link && cd ../..   # makes `personaxis` global, pointing at YOUR build
personaxis proof --quick
```

After editing source: `pnpm run build` again (the global link picks the new build up
automatically). Tests: `pnpm run test`. Without the link, every `personaxis <cmd>` below is
`node packages/cli/dist/index.js <cmd>` (or `pnpm run cli -- <cmd>`).

## Your first 10 minutes

**1. Create a persona** (in any folder: your project, or an empty dir):

```bash
personaxis create dev-buddy --from-prompt "A blunt senior code reviewer. Never rubber-stamps;
praises only what earned it; explains the WHY of every rejection. Patient with juniors."
```

You get four files under `.personaxis/personas/dev-buddy/`: `personaxis.md` (the quantitative
10-layer spec, **this is the persona**), `PERSONA.md` (the compiled document a model actually
reads), `state.json` (its mutable runtime state), and `creation-report.md` (**read this one**:
it shows which sentence of your brief produced each number, and labels every default it had to
assume). No brief? Run `personaxis create dev-buddy` with no flags for the psychometric
interview, or `--from-project` to infer a persona from your repo, or `--from-import card.png`
to upgrade a character card.

**2. Talk to it**: the REPL is the app:

```bash
personaxis --persona .personaxis/personas/dev-buddy/personaxis.md
# › chat in natural language, or: /state /drift /arbitrate /replay /audit /memory /persona /help
```

It works offline (heuristic appraiser). For real conversation quality, point it at any
OpenAI-compatible model once:

```bash
export PERSONAXIS_ENDPOINT=http://localhost:11434/v1   # Ollama / LM Studio / llama.cpp / hosted
export PERSONAXIS_MODEL=qwen3:4b                       # even a small local model is safe here
```

**3. Watch it live, bounded.** Every turn runs a governed tick: state moves only inside the
declared envelopes, every change lands in a hash-chained audit log, and behavior changes only
when a value crosses a declared band. See exactly where it is:

```bash
personaxis state drift -f .personaxis/personas/dev-buddy/personaxis.md
                              # per-coordinate position, band, and the audited cost of change
personaxis dash               # live dashboard in a second terminal
```

**4. Give it to your coding agent** (Claude Code / Codex / Cursor):

```bash
personaxis compile dev-buddy --platform claude-code   # -> .claude/agents/dev-buddy.md
personaxis-mcp                                        # or: MCP server with 16 persona tools
```

Where to next: [`docs/guides/getting-started.md`](docs/guides/getting-started.md) (by
audience) · [`docs/guides/creating-personas.md`](docs/guides/creating-personas.md) (all the
`create` doors + how to review provenance) · [`docs/guides/production.md`](docs/guides/production.md)
(deploy, CI gates, troubleshooting) · [`docs/guides/recipes.md`](docs/guides/recipes.md)
(8 vertical starting points).

---

## Living persona (what's actually running)

Each REPL turn feeds a **governed Living Loop** (`observe → appraise → evolve → recompile →
memory`) where every state change is **clamped to the persona's envelopes, audited in an
immutable mutation log, and reversible**, and episodic memory is written to an **append-only
hash chain** (tamper/poisoning-evident). Identity stays immutable; only `state.json` and
memory evolve, within the spec's universal invariants. The model, any model, only
*proposes*; the code and the spec *enforce*.

This repo is a **pnpm monorepo** of eight lockstep packages (`@personaxis/spec`, `core`, `protocol`, `persona.md` [the CLI], `mcp`, `sdk`, `evals`, `tui`).

**📖 How it works:** [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md): what personaxis is, the three-artifact model, the governed Living Loop, the security model, the full command reference, and the architecture. **📄 The paper:** [`docs/paper/bounded-persona-dynamics.md`](docs/paper/bounded-persona-dynamics.md), *Bounded Persona Dynamics* (theorems, preregistered experiments, recorded results). `plan/` is the historical research dossier.

---

## Spec toolchain quick reference

```bash
personaxis init                                   # scaffold from the commented template (prefer `create`)
personaxis validate                               # 5-state validator (PASS ... FAIL_CONCEPTUAL)
personaxis lint
personaxis compile --root                         # root persona -> PERSONA.md
personaxis compile <slug> --platform claude-code  # subagent -> .claude/agents/<slug>.md
personaxis compile <slug> --platform codex        # subagent -> .codex/agents/<slug>.toml
```

Migrate an existing persona:

```bash
personaxis migrate 0.5-to-0.6 ./PERSONA.md --apply   # v0.5 -> v0.6 structural codemod
personaxis migrate 0.6-to-0.7 --apply                # v0.6 layout -> v0.7 layout
personaxis migrate 0.7-to-0.8 --apply                # v0.7 -> v0.8 (additive: spec_version bump)
personaxis migrate 0.10-to-1.0 --apply               # v0.10 -> v1.0 (stable spec; breaking, comment-preserving)
```

Mutate runtime state (clamped to envelopes declared in personaxis.md):

```bash
personaxis state init                                  # seed state.json from envelope means
personaxis state mutate --field mood.tone --delta -0.10 --reason "less playful"
personaxis state show
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
| `list` | List personas installed in this project |
| `spec` | Print the v1.1.0 spec, useful for injecting into agent prompts |
| **`state init`** | **v0.6:** Create `state.json` beside PERSONA.md, seeded from envelope means |
| **`state mutate`** | **v0.6:** Adjust a current value (clamped to envelope, logged to mutation_log) |
| **`state show`** | **v0.6:** Pretty-print current state, active context, and recent mutations |
| **`migrate 0.5-to-0.6`** | **v0.6:** Apply structural codemod (folder renames, governance unification, etc.) with a written report |
| **`push [--root\|<slug>]`** | **v0.7.0:** Validate, decompile if `PERSONA.md`/`<slug>.md` was hand-edited, recompile, and upload a new `AgentPersonaVersion` |
| **`pull [--root\|<slug>]`** | **v0.7.0:** Download a persona version (spec, compiled document, and support folders) into the local layout |
| **`skills list [--root\|<slug>]`** | **v0.7.0:** List `extensions.skills` entries and their materialization status (`materialized`, `missing-local`, `reference-only`) |
| **`skills pull <name> [--root\|<slug>]`** | **v0.7.0:** Pull a `github:org/repo[/path]` skill entry into `skills/<name>/`, validate it against agentskills.io rules, and offer to rewrite the `extensions.skills` entry to `./skills/<name>` |
| **`migrate 0.7-to-0.8`** | **v0.8.0:** Additive bump (no field changes); makes the new optional fields available |
| **(no subcommand)** | **v0.8.0:** Enter the living **REPL**: talk to your persona; it replies and evolves via the governed Living Loop. First run scaffolds a valid starter persona |
| **`sigil [--persona <p>]`** | **v0.8.0:** Render a persona's deterministic, state-aware ASCII sigil + envelope panel |
| **`overseer show\|register\|collection`** | **v0.8.0:** The master view: all personas, projects, and **collections** (taxonomy) |
| **`team create\|add\|goal\|show`** | **v0.8.0:** Operational multi-agent **teams** (roles + lead + shared goal), distinct from collections |
| **`orchestrate "<task>" [--team <name>] [--run]`** | **v0.8.0:** Route a task to the best-matching persona via the capability blackboard |
| **`sync <other-state.json> --persona <p>`** | **v0.8.0:** Reconcile a portable persona's `state.json` across machines (no clobber) |
| **`serve --persona <p>`** | **v0.8.0:** Serve a persona over HTTP + `agents.md` (low-context interop for any agent) |
| **`edit <dot-path> <value>`** | **v1.0:** Surgical, governed single-leaf edit; re-validates and refuses any edit that would break a universal (`--force`, `--dry-run`) |
| **`state rebuild`** | **v1.0:** Replay the mutation_log to rebuild/repair `state.json` as a derived checkpoint (drift detection; `--write`) |
| **`dash [--persona <p>]`** | **v1.0:** Live ASCII dashboard (Ink): sigil, envelopes, and chain, reflecting evolution in real time |
| **`migrate 0.10-to-1.0`** | **v1.0:** Codemod to the stable spec (layer-9 rename, `persona_prompting`→`persona`, refusal-surface fold, memory knobs→`runtime`, dot-path state keys) |
| **`create [slug]`** | **v1.1:** Persona Genesis: interview / `--from-prompt` / `--from-project` / `--from-import` (cards V2/V3, system prompts) / `--from-transcript` → valid-by-construction spec + creation report with per-number provenance |
| **`proof [--quick] [--auto]`** | **v1.1:** Watch the guarantees hold, offline: adversarial storm (0 escapes), certified band-crossing cost, tamper located, deterministic replay |
| **`state drift`** | **v1.1:** Per-coordinate `u`/band/headroom + T3 evidence cost; layer `D` vs `governance.drift_thresholds` (exit 2 past tolerance, the CI gate) |
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
| `cursor` | `.cursor/rules/persona.mdc` | n/a | Archived |
| `soul-md` | `SOUL.md` | n/a | Archived |

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
