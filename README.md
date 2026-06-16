# @personaxis/persona.md

> **This version has not been published to npm yet.** The code in this repository is ahead of the latest npm release. To use the latest published version run `npx @personaxis/persona.md`. To use this unreleased version, clone the repo and run `pnpm install && pnpm run build && node dist/index.js`.

[![npm](https://img.shields.io/npm/v/@personaxis%2Fpersona.md)](https://www.npmjs.com/package/@personaxis/persona.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Spec](https://img.shields.io/badge/spec-0.7.0-informational)](https://github.com/personaxis/persona.md/blob/main/docs/SPEC.md)

CLI for [PERSONA.md](https://github.com/personaxis/persona.md) -- define, validate, lint, compile, decompile, push, pull, and migrate AI agent personas (spec v0.7.0 / Personaxis v12).

Full documentation lives in the [PERSONA.md spec repository](https://github.com/personaxis/persona.md).

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
| `spec` | Print the v0.7.0 spec — useful for injecting into agent prompts |
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

## v0.7 three-artifact model

A persona package in v0.7 contains these primary artifacts:

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
