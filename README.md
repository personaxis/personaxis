# personaxis

> **Living, governed AI agent personas.** Define who an agent is once, run it unchanged on any model, and get mathematical guarantees it cannot drift outside what you declared.

[![npm](https://img.shields.io/npm/v/personaxis)](https://www.npmjs.com/package/personaxis)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Spec](https://img.shields.io/badge/spec-1.1.0-informational)](https://github.com/personaxis/persona.md/blob/main/docs/SPEC.md)

This is the **personaxis monorepo**: eight lockstep packages that implement the
[personaxis.md spec](https://github.com/personaxis/persona.md). The command-line tool ships to
npm as **`personaxis`** and installs the `personaxis` command.

Define an AI persona once (all ten layers, not just a name and a vibe) in plain, git-versionable
files; run it unchanged on Claude, GPT, Gemini, or a local model; and get **mathematical
guarantees** that it cannot drift outside what you declared:

- **It can't escape.** Every mutable value lives in a declared envelope, and no adversarial input
  sequence can leave it (theorem T1, checked against **2.3M generated adversarial cases, 0
  counterexamples**: [`docs/GUARANTEES.md`](docs/GUARANTEES.md)).
- **Change is forensic.** Pushing behavior away from its declared baseline costs a provable
  minimum of hash-chained audit entries (T3); history replays deterministically, and tampering is
  located, not just detected (T4/T5).
- **Created from anything, grounded in evidence.** `personaxis create` builds a
  valid-by-construction persona from an interview, a prompt, your repo, a character card, or
  transcripts, with a creation report giving the provenance of every number.

**Documentation:** [`docs/`](docs/README.md) (this repo, the CLI) ·
[`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md) (the overview) ·
[`docs/commands/`](docs/commands/README.md) (every command, flag, and exit code) ·
[`docs/guides/`](docs/guides/) (task-oriented) ·
[`docs/GUARANTEES.md`](docs/GUARANTEES.md) (evidence scoreboard) ·
[`docs/architecture/math-core.md`](docs/architecture/math-core.md) (theorem-to-code map). The
normative spec itself lives in the sibling [persona.md](https://github.com/personaxis/persona.md)
repository.

---

## Install

**Users (npm).** Install the published CLI, no clone needed:

```bash
npm i -g personaxis
personaxis proof --quick     # 60 s, offline: watch the guarantees hold before trusting them
```

**Developers (from source).** For hacking on personaxis, or the newest code before it is
published (Node 18+, pnpm):

```bash
git clone https://github.com/personaxis/personaxis && cd personaxis
pnpm install
pnpm run build                            # builds the eight packages
cd packages/cli && npm link && cd ../..   # makes `personaxis` global, pointing at YOUR build
personaxis proof --quick
```

After editing source, run `pnpm run build` again (the global link picks up the new build). Run
the suite with `pnpm run test`. Without the link, every `personaxis <cmd>` below is
`node packages/cli/dist/index.js <cmd>`.

## Your first 10 minutes

**1. Create a persona** (in any folder: your project, or an empty dir):

```bash
personaxis create dev-buddy --from-prompt "A blunt senior code reviewer. Never rubber-stamps;
praises only what earned it; explains the WHY of every rejection. Patient with juniors."
```

You get four files under `.personaxis/personas/dev-buddy/`: `personaxis.md` (the quantitative
ten-layer spec, **this is the persona**), `PERSONA.md` (the compiled document a model actually
reads), `state.json` (its mutable runtime state), and `creation-report.md` (**read this one**: it
shows which sentence of your brief produced each number, and labels every default it assumed).
No brief? Run `personaxis create dev-buddy` with no flags for the psychometric interview,
`--from-project` to infer a persona from your repo, or `--from-import card.png` to upgrade a
character card.

**2. Talk to it.** The REPL is the app:

```bash
personaxis --persona .personaxis/personas/dev-buddy/personaxis.md
# chat in natural language, or: /state /drift /arbitrate /replay /audit /memory /persona /help
```

It works offline (heuristic appraiser). For real conversation quality, point it at any
OpenAI-compatible model once:

```bash
export PERSONAXIS_ENDPOINT=http://localhost:11434/v1   # Ollama / LM Studio / llama.cpp / hosted
export PERSONAXIS_MODEL=qwen3:4b                        # even a small local model is safe here
```

**3. Watch it live, bounded.** Every turn runs a governed tick: state moves only inside the
declared envelopes, every change lands in a hash-chained audit log, and behavior changes only
when a value crosses a declared band.

```bash
personaxis state drift -f .personaxis/personas/dev-buddy/personaxis.md   # position, band, cost of change
personaxis dash                                                          # live dashboard, second terminal
```

**4. Give it to your coding agent** (Claude Code, Codex, Cursor):

```bash
personaxis compile dev-buddy --platform claude-code   # writes .claude/agents/dev-buddy.md
personaxis-mcp                                        # or run the MCP server (16 persona tools)
```

Where to next: [`docs/guides/getting-started.md`](docs/guides/getting-started.md) (by audience) ·
[`docs/guides/creating-personas.md`](docs/guides/creating-personas.md) (every `create` door and
how to review provenance) · [`docs/guides/production.md`](docs/guides/production.md) (deploy, CI
gates, troubleshooting) · [`docs/guides/recipes.md`](docs/guides/recipes.md) (eight vertical
starting points).

---

## What is actually running

Each REPL turn feeds a **governed Living Loop** (`observe → appraise → evolve → recompile →
memory`). Every state change is **clamped to the persona's envelopes, audited in an immutable
mutation log, and reversible**, and episodic memory is an **append-only hash chain**
(tamper-evident and poisoning-evident). Identity stays immutable; only `state.json` and memory
evolve, within the spec's universal invariants. The model, any model, only *proposes*; the code
and the spec *enforce*.

The eight lockstep packages: **`@personaxis/spec`** (schemas, validator, universals),
**`core`** (the engine, math core, Living Loop, Genesis), **`protocol`** (the op/event transport),
**`personaxis`** (the CLI), **`mcp`** (the MCP server), **`sdk`** (the in-process façade),
**`evals`** (the conformance harness), and **`tui`** (the ASCII dashboard).

## The three version numbers

They are independent on purpose, so read them separately:

| Number | Example | What it versions | Where you see it |
|---|---|---|---|
| Package / CLI | `0.12.0` | the software (all eight packages move together, lockstep) | `personaxis --version` |
| Spec | `1.1.0` | the `personaxis.md` file format the software implements | `spec_version:` in every persona |
| apiVersion | `personaxis.com/v1` | the stable API namespace of the spec | `apiVersion:` in every persona |

The software at `0.12.0` implements spec `1.1.0`. The CLI can keep releasing while still targeting
spec `1.1.0`, and a persona written for spec `1.0.0` keeps validating because `1.1.0` only adds
optional fields.

---

## Command reference

A curated subset is below. The complete reference, one page per command with every flag and exit
code, is [`docs/commands/`](docs/commands/README.md).

| Command | Description |
|---|---|
| `create [slug]` | Genesis: build a valid-by-construction persona from an interview, `--from-prompt`, `--from-project`, `--from-import` (cards V2/V3, system prompts), or `--from-transcript`, with per-number provenance |
| `(no subcommand)` | Enter the living REPL: talk to your persona; it replies and evolves via the governed Living Loop |
| `validate` | Schema and universals validation; returns `PASS`, `PASS_WITH_WARNINGS`, `FAIL_SCHEMA`, `FAIL_POLICY`, or `FAIL_CONCEPTUAL`. Also validates sibling `policy.yaml` and `state.json` |
| `lint` | Semantic lint with structured findings (errors, warnings, info) |
| `init [--agent \| --user]` | Scaffold a persona (project baseline, agent persona, or user persona) |
| `compile [<slug>] [--root] [--platform <p>]` | Compile `personaxis.md` to `PERSONA.md` (root) or a subagent document, via the configured provider |
| `decompile [<slug>] [--root]` | Fold a hand-edited `PERSONA.md` back into a proposed `personaxis.md` (validated before write) |
| `edit <dot-path> <value>` | Surgical, governed single-leaf edit; re-validates and refuses any edit that breaks a universal |
| `state init \| mutate \| show \| drift \| rebuild` | Seed, adjust (clamped + logged), inspect, measure drift, or replay the mutation log |
| `proof [--quick]` | Watch the guarantees hold, offline: adversarial storm, certified band-crossing cost, tamper located, deterministic replay |
| `jacobian` | Exact compile-sensitivity per coordinate; flags provably decorative numbers |
| `arbitrate [a] [b]` | Deterministic value-conflict resolution with a trace (`governance` ≻ `weight` ≻ name) |
| `dash [--persona <p>]` | Live ASCII dashboard: sigil, envelopes, and chain, reflecting evolution in real time |
| `sigil [--persona <p>]` | Render a persona's deterministic, state-aware ASCII sigil and envelope panel |
| `push \| pull` | Publish or fetch a persona version (spec, compiled document, and support folders) |
| `skills list \| pull` | Inspect `extensions.skills` entries and pull `github:` skills into `skills/<name>/` |
| `overseer` / `team` / `orchestrate` | The master view; operational multi-agent teams; capability-routed task dispatch |
| `serve --persona <p>` | Serve a persona over HTTP and `agents.md` for agents that do not speak MCP |
| `sync <other-state.json>` | Reconcile a portable persona's `state.json` across machines (no clobber) |
| `migrate <from>-to-<to>` | Structural codemods between spec versions (up to `0.10-to-1.0`), each with a written report |
| `export`, `diff`, `spec`, `list`, `template` | Export frontmatter, diff two versions, print the spec, list installed personas, manage templates |

### Validate exit codes

| Status | Exit | Meaning |
|---|---|---|
| `PASS` | 0 | All MUST present and all universals satisfied |
| `PASS_WITH_WARNINGS` | 0 | Valid but missing SHOULDs or near-universal recommendations |
| `FAIL_SCHEMA` | 1 | MUST field absent or wrong type |
| `FAIL_POLICY` | 2 | A universal policy invariant violated |
| `FAIL_CONCEPTUAL` | 3 | Prohibited claim or wrong universal constant |

### Compile targets

| Platform | Root output | Subagent output | Skills |
|---|---|---|---|
| `claude-code` | `PERSONA.md` (+ `CLAUDE.md` baseline) | `.claude/agents/<slug>.md` | materialized to `.claude/skills/<name>/` |
| `codex` | `PERSONA.md` (+ `AGENTS.md` baseline) | `.codex/agents/<slug>.toml` | materialized to `.agents/skills/<name>/` |
| `cursor` | `.cursor/rules/persona.mdc` | n/a | archived |
| `soul-md` | `SOUL.md` | n/a | archived |

Compile is LLM-based (via the configured provider). Edit
`.personaxis/[personas/<slug>/]personaxis.md`, then recompile; do not hand-edit the generated
`PERSONA.md`, `.claude/agents/`, `.codex/agents/`, or materialized skills (use `personaxis
decompile` to fold hand-edits back into the spec).

---

## The three-artifact model

| Artifact | Role | Who writes it |
|---|---|---|
| `.personaxis/[personas/<slug>/]personaxis.md` | The quantitative ten-layer spec (source of truth) | Humans, or the persona under governance, via `decompile` |
| `PERSONA.md` / `.claude/agents/<slug>.md` | The compiled, LLM-facing document | Generated via `compile` |
| `state.json` | Mutable runtime state (trait/affect/mood values) | `state mutate` (CLI) or `adjust_persona_state` (runtime) |
| `policy.yaml` | Observability and improvement policy | Ops; never inlined into the actor prompt |

State mutations are clamped to the envelopes (`{mean, range}`) declared in `personaxis.md`. The
mutation log in `state.json` records every change with its timestamp, actor, reason, and whether
the runtime clamped it or governance blocked it.

## Skills

`extensions.skills` is an index, not a content host. Each entry resolves to a folder with a
`SKILL.md` (agentskills.io format):

```yaml
extensions:
  skills:
    - "./skills/quarterly-planning"   # local, materialized on compile
    - "@org/name@1.2.0"               # registry, reference-only
    - "github:org/repo/path"          # github, pullable
```

`personaxis compile` materializes every local entry into the target platform's skill-discovery
directory, and writes `skills-manifest.json` recording each entry's status (`materialized`,
`missing-local`, or `reference-only`). `personaxis skills pull` clones a `github:` skill into
`skills/<name>/`, validates its `SKILL.md`, and rewrites the entry to the local path.

---

## License

MIT.
