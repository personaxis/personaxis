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
| [`observe`](./observe.md) | Feed one observation → one governed tick on your model + drift recompile (`--stdin` for host hooks). |
| [`watch`](./watch.md) | Optional local daemon: recompile on hand-edits + a drift heartbeat (`--once` for cron/CI). |
| [`hooks`](./hooks.md) | Install/remove the Claude Code end-of-turn hook that feeds `observe` (per-turn learning). |
| [`config`](../configuration.md) | Set the model/endpoint/key (global or project, per-persona). |
| [`improve [mode]`](./improve.md) | View/set self-improvement posture (`locked` / `suggesting` / `autonomous`). |
| [`state`](./state.md) | init / show / mutate `state.json` (envelope-clamped). |
| [`migrate <a-to-b>`](./migrate.md) | Version codemods (`0.9-to-0.10` is additive — bumps `spec_version`). |
| [`sigil`](./sigil.md) | Render a persona's deterministic, state-aware ASCII sigil. |
| [`scan`](./scan.md) | Cross-harness config scanner (red/blue/auditor). |
| [`push` / `pull`](./push-pull.md) | Publish / fetch a persona version (spec + compiled doc + resources). |
| [`personas`](./personas.md) | Global persona registry (reuse across projects). |
| [`overseer`](./overseer.md) | Optional local registry of personas/projects (powers `orchestrate`). |
| [`serve`](./serve.md) | Runtime / MCP serving. |
| [`trace`](./trace.md) | Inspect JSONL/OTLP traces. |
| [_(no subcommand)_](./repl.md) | Enter the living **REPL**. |

## REPL slash-commands

| Command | What it does |
|---|---|
| `/help` | List commands. |
| `/persona` | Identity, role (root/sub), sub-personas, resources + sigil. |
| `/state` | Show runtime state + envelopes. |
| `/improve [mode]` | View/set self-improvement mode `locked\|suggesting\|autonomous` (≠ `/mode`). |
| `/review [approve\|reject] <id\|all>` | Review the queue of proposed qualitative self-edits. |
| `/compile` | Recompile `PERSONA.md` from the evolved spec (only when marked stale). |
| `/model [set …]` | Show the resolved model, or set endpoint/model/key-env (project or `global`). |
| `/mode` | Cycle the sandbox posture (shift+tab also). |
| `/memory` | Inspect all six memory kinds + verify the hash chain. |
| `/audit` | Mutation log + memory-chain integrity + self-edit ledger + evaluations. |
| `/sessions` | List saved conversations (`● live` marks the current one). |
| `/resume <id\|name>` | Resume a saved conversation (restores a persisted `/compact`). |
| `/compact` | Compact the conversation context — persisted, survives `/resume` (also auto at ~80%). |
| `/goal` | Set / show / clear a standing goal. |
| `/loop` | Run N internal ticks. |
| `/overseer` | Cross-machine/project registry view (optional infra). |
| `/exit` | Leave. |

> Chatting plain text both converses AND uses tools (one governed agent loop) — there is no
> separate `/do`. Evolution runs every turn — there is no separate `/evolve`. The sigil is
> folded into `/persona`.

**Multi-persona** (not slash-commands): address sub-personas inline with `@slug …` or
`@all …`. See [multi-persona](../architecture/multi-persona.md). New feature docs:
[memory](../architecture/memory.md), [sessions](../architecture/sessions.md),
[self-evolution](../architecture/self-evolution.md), [awareness](../architecture/awareness.md),
[sandbox](../architecture/sandbox.md).
