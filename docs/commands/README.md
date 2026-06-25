# Commands

Two surfaces: **CLI subcommands** (`personaxis <cmd>`) and **REPL slash-commands** (inside
the interactive session). Source of truth: `packages/cli/src/index.ts` (CLI) and the
`COMMANDS` registry in `packages/cli/src/repl/index.ts` (REPL).

> Per-command deep-dives live alongside this index (e.g. `improve.md`, `compile.md`) and are
> filled in as features stabilize. This page is the authoritative index.

## CLI subcommands

| Command | What it does |
|---|---|
| [`init [slug]`](./init.md) | Scaffold a persona (root or sub) — generates `personaxis.md` + `policy.yaml` (spec 0.10). |
| [`validate <file>`](./validate.md) | 5-status validator (PASS / PASS_WITH_WARNINGS / FAIL_SCHEMA / FAIL_POLICY / FAIL_CONCEPTUAL). |
| [`lint <file>`](./lint.md) | Tier-aware semantic findings against the layer/field contract. |
| [`compile [slug]`](./compile.md) | Compile to the canonical `PERSONA.md`; `--platform` exports a host placement. |
| [`decompile`](./decompile.md) | Reverse: edited compiled doc → proposed `personaxis.md` (re-validates before writing). |
| [`improve [mode]`](./improve.md) | View/set self-improvement posture (`locked` / `suggesting` / `autonomous`). |
| [`state`](./state.md) | init / show / mutate `state.json` (envelope-clamped). |
| [`migrate <a-to-b>`](./migrate.md) | Version codemods (`0.9-to-0.10` is additive — bumps `spec_version`). |
| [`sigil`](./sigil.md) | Render a persona's deterministic, state-aware ASCII sigil. |
| [`scan`](./scan.md) | Cross-harness config scanner (red/blue/auditor). |
| [`push` / `pull`](./push-pull.md) | Publish / fetch a persona version (spec + compiled doc + resources). |
| [`personas`](./personas.md) | Global persona registry (reuse across projects). |
| [`serve`](./serve.md) | Runtime / MCP serving. |
| [`trace`](./trace.md) | Inspect JSONL/OTLP traces. |
| [_(no subcommand)_](./repl.md) | Enter the living **REPL**. |

## REPL slash-commands

| Command | What it does |
|---|---|
| `/help` | List commands. |
| `/persona` | Show the active persona summary. |
| `/state` | Show runtime state + envelopes. |
| `/improve [mode]` | View/set self-improvement mode (≠ `/mode`). |
| `/mode` | Cycle the sandbox posture (shift+tab also). |
| `/evolve <text>` | Run one governed Living-Loop cycle (shows the steps). |
| `/do <task>` | Hand the persona a task (governed Agent Loop). |
| `/memory` | Inspect memory + verify the hash chain. |
| `/audit` | Governance/overseer view. |
| `/goal` | Set / show / clear a standing goal. |
| `/loop` | Run N internal ticks. |
| `/compact` | Compact the conversation context. |
| `/exit` | Leave. |

**Multi-persona** (not slash-commands): address sub-personas inline with `@slug …` or
`@all …`. See [multi-persona](../architecture/multi-persona.md).
