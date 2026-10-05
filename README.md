# personaxis

A persona is the whole way a professional works: the procedures it follows, the criteria it applies,
the tools it reaches, the knowledge it cites with sources, what it has learned on the job, and the
limits it keeps. Personaxis writes that down as plain files you version with git, and any agent can
load it: Claude Code and Codex through `CLAUDE.md` or `AGENTS.md`, OpenClaw and Hermes through
`SOUL.md`, any MCP host through `@personaxis/mcp`, and editors that speak ACP through `personaxis-acp`.

[![npm](https://img.shields.io/npm/v/personaxis)](https://www.npmjs.com/package/personaxis)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Spec](https://img.shields.io/badge/spec-1.1.0-informational)](https://github.com/personaxis/persona.md/blob/main/docs/SPEC.md)

This repository holds the eight packages that implement the open
[personaxis.md spec](https://github.com/personaxis/persona.md). The command-line tool ships to npm as
`personaxis`.

What this version does not include: a hosted hub to publish and pull personas, a bench that measures
how much a persona improves an agent on each model, and a web studio. They are being built, and none
of their commands are in this package. [`docs/GUARANTEES.md`](docs/GUARANTEES.md) lists what is
measured today and what is not.

---

## Install

```bash
npm i -g personaxis
personaxis proof --quick     # 60 s, offline: runs the engine's own checks on a throwaway persona
```

Or without installing: `npx personaxis proof --quick`.

> **Windows / PowerShell.** If a global command prints `running scripts is disabled on this
> system`, PowerShell is blocking npm's `.ps1` launcher, as it does for every npm-installed CLI. Fix
> it once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or call `personaxis.cmd ...`
> or `npx personaxis ...` instead.

From source (Node 20.18.1+, pnpm):

```bash
git clone https://github.com/personaxis/personaxis && cd personaxis
pnpm install
pnpm run build
node packages/cli/dist/index.js proof --quick
```

Every `personaxis <cmd>` below is `node packages/cli/dist/index.js <cmd>` from a source checkout.

## Your first ten minutes

**1. Create a persona** in any folder:

```bash
personaxis create reviewer --from-prompt "A code reviewer who blocks merges without tests and explains every rejection."
```

You get four files under `.personaxis/personas/reviewer/`: `personaxis.md` (the definition, in ten
layers), `PERSONA.md` (the compiled document a model reads), `state.json` (the values that move as it
works) and `creation-report.md`. Read the report. It shows which sentence of your brief produced each
number and labels every default it assumed. Without a working model most of the persona is labelled
defaults, so configure one first (step 2) if you want a persona built from evidence.

Other ways in: no flag starts an interview, `--from-project` reads your repository's own docs,
`--from-import` takes a SOUL.md or SoulSpec package, a character card or a system prompt, and
`--from-transcript` works from example conversations. `--research` searches the web for the field and
keeps what it found in `references/`, each source with its date.

**2. Point it at a model.** Any OpenAI-compatible endpoint works, hosted or local:

```bash
export PERSONAXIS_ENDPOINT=http://localhost:11434/v1   # Ollama, LM Studio, llama.cpp or a hosted API
export PERSONAXIS_MODEL=qwen3:4b                        # a small local model works; expect weaker tool use
```

`personaxis model` shows which model each persona resolves to, and sets it per persona.

**3. Load it into your agent:**

```bash
personaxis compile reviewer --platform claude-code   # writes .claude/agents/reviewer.md
npx -y @personaxis/mcp                               # or serve it to any MCP host (16 tools)
```

**4. Talk to it directly**, if you want to see it work outside your agent:

```bash
personaxis --persona .personaxis/personas/reviewer/personaxis.md
# chat in plain language, or: /persona /status /audit /memory /doctor /help
```

Next: [`docs/guides/getting-started.md`](docs/guides/getting-started.md) ·
[`docs/guides/creating-personas.md`](docs/guides/creating-personas.md) ·
[`docs/commands/`](docs/commands/README.md) (every command, flag and exit code).

---

## How each agent loads a persona

| Agent | How it reads the persona | Command |
|---|---|---|
| Claude Code | `PERSONA.md`, referenced as `@PERSONA.md` from `CLAUDE.md`; or a subagent in `.claude/agents/<slug>.md`; or MCP | `compile --platform claude-code`, `@personaxis/mcp` |
| Codex | `PERSONA.md`, referenced from `AGENTS.md`; or `.codex/agents/<slug>.toml`; or MCP | `compile --platform codex`, `@personaxis/mcp` |
| Cursor and other editors that read `AGENTS.md` | the `AGENTS.md` baseline | `compile --platform codex` |
| OpenClaw | `SOUL.md` | `compile --platform openclaw` |
| Hermes | `.hermes/SOUL.md` | `compile --platform hermes` |
| Editors that speak ACP | the persona runs as the agent | `personaxis-acp` |
| Anything over HTTP | an `agents.md` endpoint | `personaxis serve --persona <path>` |

MCP registration is documented and tested for Claude Code and Codex
([`docs/integrations/claude-code-mcp.md`](docs/integrations/claude-code-mcp.md)). Cursor is reached
through `AGENTS.md`; there is no tested MCP snippet for it yet.

## What a persona brings to a job

| What it has | Where it lives | How the agent reaches it |
|---|---|---|
| Skills | `.personaxis/personas/<slug>/skills/<name>/SKILL.md` | `use_skill` loads the method before the work starts |
| Services | `.personaxis/services/<name>.json` | `run_service` runs a multi-step job; every step must leave the files it declares, and the run keeps a journal |
| References | `.personaxis/personas/<slug>/references/` | `read_file`, by the path the index gives it |
| Sub-personas | `.personaxis/personas/<slug>/personas/` | `delegate`, for work one of them is made for |
| Memory | its own store, an append-only hash chain | `memory_search`, before it says it does not remember |

It also gets `ask_person`, for a missing fact it should not invent, and `check_page`, which runs a page
it just built and reads back the line that failed.

## What the engine enforces

A loaded persona is only worth trusting if its limits hold when the model is wrong or under attack.
These hold in code, not in the prompt:

- Every value that can change stays inside the range the persona declares. Theorem T1, checked on
  2,306,140 generated adversarial cases with 0 counterexamples ([`docs/GUARANTEES.md`](docs/GUARANTEES.md)).
- A tool call that no permission covers does not run.
- Every turn and every change is written to a hash-chained record. History replays deterministically,
  and a tampered entry is located by its position in the chain.
- `@personaxis/evals` runs 19 conformance scenarios with no API keys, on every CI build.

What it does not decide is whether the model makes the right call. A small open model will sometimes
answer from memory what its own service answers better, or do a job itself instead of handing it to
the sub-persona built for it. That is why the limits live in the tool layer: a wrong decision still
cannot run a forbidden action.

## Packages

| Package | What it is |
|---|---|
| `@personaxis/spec` | the schemas, the validator and the universal rules |
| `@personaxis/core` | the engine: state, the loop, the record, Genesis |
| `@personaxis/protocol` | the transport between a front end and the engine, and the ACP bridge |
| `personaxis` | the CLI |
| `@personaxis/mcp` | the MCP server |
| `@personaxis/sdk` | run a persona inside your own Node or TypeScript backend |
| `@personaxis/evals` | the conformance suite |
| `@personaxis/tui` | the terminal interface |

All eight move together on one version: `personaxis --version`.

---

## Command reference

The most used commands are below. Every command, with every flag and exit code, is in
[`docs/commands/`](docs/commands/README.md).

| Command | What it does |
|---|---|
| `create [slug]` | Build a persona from an interview, a brief, a project, an import or transcripts, with a creation report |
| `compile [slug] [--platform <p>]` | Write the document an agent reads, for one of the four platforms below |
| `validate` | Check the schema and the universal rules; exit codes below |
| `lint` | Findings with a fix for each one |
| `decompile [slug]` | Fold a hand-edited `PERSONA.md` back into the definition, validated before it writes |
| `edit <path> <value>` | Change one field; refuses any edit that breaks a universal rule |
| `state init \| mutate \| show \| rebuild \| rewind` | Seed, adjust (clamped and logged), inspect, replay or undo the persona's moving values |
| `status \| audit \| memory \| doctor` | The REPL's views from a shell, with `--json` |
| `skills list \| pull` | List a persona's skills and pull `github:` skills locally |
| `service run \| resume` | Run a multi-step service on this machine, and resume one waiting on an answer |
| `serve --persona <p>` | Serve a persona over HTTP for agents that do not speak MCP |
| `hooks install` | Wire Claude Code, Codex, OpenClaw or Hermes so the persona learns from each turn |
| `proof [--quick]` | Run the engine's checks offline on a throwaway persona |
| `export`, `diff`, `spec`, `list`, `template`, `migrate`, `sync` | Export, compare two versions, print the spec, list personas, templates, spec migrations, reconcile state across machines |

More advanced commands (`jacobian`, `sign`, `verify`, `attest`, `arbitrate`, `guard`, `team`,
`orchestrate`, `overseer`, `dash`, `sigil`) have their own pages in [`docs/commands/`](docs/commands/README.md).

### Validate exit codes

| Status | Exit | Meaning |
|---|---|---|
| `PASS` | 0 | Every required field present and every universal rule satisfied |
| `PASS_WITH_WARNINGS` | 0 | Valid, with recommended fields missing |
| `FAIL_SCHEMA` | 1 | A required field is missing or has the wrong type |
| `FAIL_POLICY` | 2 | A universal rule is violated |
| `FAIL_CONCEPTUAL` | 3 | A prohibited claim or a wrong universal constant |

### Compile targets

| Platform | Root output | Subagent output | Skills |
|---|---|---|---|
| `claude-code` | `PERSONA.md` (+ `CLAUDE.md` baseline) | `.claude/agents/<slug>.md` | copied to `.claude/skills/<name>/` |
| `codex` | `PERSONA.md` (+ `AGENTS.md` baseline) | `.codex/agents/<slug>.toml` | copied to `.agents/skills/<name>/` |
| `openclaw` | `SOUL.md` | `.openclaw/agents/<slug>/SOUL.md` | as `claude-code` |
| `hermes` | `.hermes/SOUL.md` | `.hermes/agents/<slug>/SOUL.md` | as `claude-code` |

Edit `.personaxis/[personas/<slug>/]personaxis.md` and recompile. Do not hand-edit the generated
files; `decompile` folds hand edits back into the definition.

## The four files of a persona

| File | Role | Who writes it |
|---|---|---|
| `personaxis.md` | The definition, in ten layers; the source of truth | You, or the persona itself under its improvement policy |
| `PERSONA.md` / `.claude/agents/<slug>.md` | The compiled document a model reads | `compile` |
| `state.json` | The values that move as it works, with a log of every change | `state mutate` or the runtime |
| `policy.yaml` | The improvement and evaluation policy | You; never placed in the model's prompt |

## Skills

`extensions.skills` lists where each skill lives. Each entry resolves to a folder with a `SKILL.md`
in the agentskills.io format:

```yaml
extensions:
  skills:
    - "./skills/quarterly-planning"   # local, copied into place on compile
    - "github:org/repo/path"          # pulled with `personaxis skills pull`
```

`compile` copies every local skill into the target platform's skill folder and writes
`skills-manifest.json` with each entry's status.

## Versions

Three numbers, versioned separately: the package (`personaxis --version`), the spec (`1.1.0`, in
`spec_version:` of every persona) and the API namespace (`personaxis.com/v1`, in `apiVersion:`). A
persona written for spec `1.0.0` still validates, because `1.1.0` only adds optional fields.

## License

MIT.
