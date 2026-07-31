# Commands

Two surfaces: **CLI subcommands** (`personaxis <cmd>`) and **REPL slash-commands** (inside
the interactive session). Source of truth: `packages/cli/src/index.ts` (CLI) and the
`COMMANDS` registry in `packages/cli/src/repl/index.ts` (REPL).

> Per-command deep-dives live alongside this index (e.g. `improve.md`, `compile.md`) and are
> filled in as features stabilize. This page is the authoritative index.

## CLI subcommands

| Command | What it does |
|---|---|
| [`create [slug]`](./create.md) | **Persona Genesis**: build a governed persona from scratch: interview, `--from-prompt`, `--from-project`, `--from-import` (character cards V2/V3, system prompts), `--from-transcript`. Valid by construction + creation report with per-number provenance. |
| [`init [slug]`](./init.md) | Scaffold a persona (root or sub) from the commented template; generates `personaxis.md` + `policy.yaml` (spec 1.0; prefer `create` for a grounded persona). |
| [`validate <file>`](./validate.md) | 5-status validator (PASS / PASS_WITH_WARNINGS / FAIL_SCHEMA / FAIL_POLICY / FAIL_CONCEPTUAL). |
| [`lint <file>`](./lint.md) | Tier-aware semantic findings against the layer/field contract. |
| [`compile [slug]`](./compile.md) | Compile to the canonical `PERSONA.md`; `--platform` exports a host placement. |
| [`decompile`](./decompile.md) | Reverse: edited compiled doc → proposed `personaxis.md` (re-validates before writing). |
| [`observe`](./observe.md) | Feed one observation → one governed tick on your model + drift recompile (`--stdin` for host hooks). |
| [`watch`](./watch.md) | Optional local daemon: recompile on hand-edits + a drift heartbeat (`--once` for cron/CI). |
| [`hooks`](./hooks.md) | Install/remove a host's end-of-turn hook (claude-code/codex/openclaw/hermes) that feeds `observe`. |
| [`onboard`](../integrations/README.md) | One command to wire a host: config check → compile → hook. |
| [`config`](../guides/configuration.md) | Set the model/endpoint/key (global or project, per-persona). |
| [`improve [mode]`](./improve.md) | View/set self-improvement posture (`locked` / `suggesting` / `autonomous`). |
| `edit <dot-path> <value>` | Surgical governed single-leaf spec edit; re-validates and refuses any edit that would break a universal ([self-evolution](../architecture/self-evolution.md)). |
| [`goal`](./goal.md) | Set/show the persona's active goal (fed to the runtime context; inside the app `/persona → Evolution`). |
| [`review`](./review.md) | Approve/reject queued self-edit proposals (the `suggesting`-mode queue; inside the app `/persona → Evolution`). |
| [`credential`](./credential.md) | Manage the persona's verifiable behavioral credential (issue / show / verify). |
| [`state`](./state.md) | init / show / mutate / rebuild `state.json` (envelope-clamped; hash-chained mutation_log). |
| [`state drift`](./drift.md) | The drift report: per-coordinate `u`, band, headroom + T3 evidence cost; per-layer `D` vs `drift_thresholds` (exit 2 on exceedance, the CI gate). |
| [`proof`](./proof.md) | Live, offline proof-of-guarantees demo ON THE ACTIVE PERSONA (throwaway copy; `--demo` for the embedded one): adversarial storm, tamper detection, replay, T3 crossing (`--quick`, `--auto`, `--persona`). |
| `model` | Show the resolved model for main + every sub, or `model set <name> [--persona <slug\|main>] [--project]` (scriptable; inside the app `/model` opens the menu). |
| [`jacobian`](./jacobian.md) | Exact compile sensitivity per coordinate (σ); flags decorative numbers (exit 2). |
| [`arbitrate [a] [b]`](./arbitrate.md) | Deterministic value-conflict resolution with an explanatory trace (governance ≻ weight ≻ name). |
| [`migrate <a-to-b>`](./migrate.md) | Version codemods (`0.10-to-1.0` is the breaking one, comment-preserving; earlier bumps additive). |
| [`sigil`](./sigil.md) | Render a persona's deterministic, state-aware ASCII sigil. |
| [`dash`](./dash.md) | Live ASCII dashboard (sigil + envelopes + memory chain), refreshed from `state.json` each frame. |
| [`scan`](./scan.md) | Cross-harness config scanner (red/blue/auditor). |
| [`sign` / `verify` / `attest`](./attest.md) | Sign the spec bytes; verify tamper-evidence; mint and re-check the local behavioral credential (drift + chain + expiry). |
| [`push` / `pull`](./push-pull.md) | Publish / fetch a persona version (spec + compiled doc + resources). |
| [`personas`](./personas.md) | Global persona registry (list/import/export/adopt; reuse across projects). |
| [`overseer`](./overseer.md) | Optional local registry of personas/projects (powers `orchestrate`). |
| [`orchestrate <task>`](./orchestrate.md) | Route a task to the best-matched registered persona (capability-ranked). |
| [`team`](./team.md) | Operational multi-agent teams (roles + shared goal), distinct from overseer collections. |
| [`sync`](./sync.md) | Reconcile a persona's state across machines (merge, no clobber). |
| [`lease`](./lease.md) | Optional exclusive write lease, for when you would rather serialise than merge. Off by default. |
| [`ps`](./ps.md) | Fleet view for this project: which personas are awake/idle, mutation counts, tone, last activity. |
| [`console`](./console.md) | Headless access to the Command Center scope tree (`ls`/`get`/`do`) for agents and CI; the same tree as `menu --tree`. |
| [`mcp`](./mcp.md) | Manage the MCP servers this persona mounts as tools (client side). |
| [`card`](./card.md) | Print a shareable persona card: the aura plus verifiable stats (spec hash, drift, chain). |
| [`serve`](./serve.md) | Expose the living persona over HTTP + `agents.md`. Binds 127.0.0.1 by default; a non-local `--host` REQUIRES `--token` (Bearer auth on every route). |
| [`skills`](./skills.md) | List / pull `extensions.skills` (e.g. `github:org/repo`) with a security review. |
| [`spec`](./spec.md) | Print the personaxis.md spec (v1.1) + lint rules, ready to inject into agent prompts. |
| [`export`](./export.md) | Export the compiled doc to clean JSON / YAML / Markdown (no pedagogical comments). |
| [`diff <a> <b>`](./diff.md) | Field-by-field diff of two `PERSONA.md`; flags breaking changes (CI gate). |
| `list` · `template` | Installed personas · authoring scaffolds (`--help` each). |
| [`runtime`](./runtime.md) | **Requires a Personaxis backend account**: hosted sessions/traces/evaluate. |
| [`trace`](./trace.md) | Inspect JSONL/OTLP traces (causal timeline). |
| [_(no subcommand)_](./repl.md) | Enter the living **REPL**. |

## REPL slash-commands (V5: real miniapps)

Inside the TUI, the big commands open MINIAPPS: full-height views with tabs and arrow
navigation that overlay the chat without erasing it (Esc returns). In pipes/CI every command
prints the same data as plain text, so scripts and agents lose nothing.

| Command | What it does |
|---|---|
| `/help` | Commands by category; `/help <q>` filters; `/help moved` maps every retired verb to its home. |
| `/persona` | Identity (with the aura) / Anatomy (the 10 layers) / Resources / Sub-personas / **Evolution** (goal, loop, improve, pending edits) / Values. |
| `/status` | Session snapshot, live envelopes, self-edits, **Config** matrix (every setting × every persona), **Usage** (spend, per model) and **Daemons**. |
| `/drift` | Three planes: continuous (u-space), structural (field by field vs the spec, any type) and behavioural (does it move the compiled document). |
| `/audit` | The Ledger: Timeline (**rewind** is an action here), Integrity (chain + replay), Self-edits, Evaluations. |
| `/memory` | Kinds → entries; Enter opens the file in your editor (cross-OS); consolidate / prune / search. |
| `/create [args]` | Genesis (interview, `--from-prompt`, `--from-import`, …); polish runs automatically when a model is configured. |
| `/compile` | Recompile the files your agents read, from the evolved spec. |
| `/skill` | Skills per persona: add, materialise (`m`), update, remove, apply; `p` switches persona. |
| `/model` | The resolved model and the provider menu. |
| `/menu` | The Command Center: `machine › project › persona` always visible, Fleet with live instances, `g` scope, `/` search. |
| `/doctor` | Offline diagnosis, **every finding with its fix**; `p` switches persona, `/doctor net` adds one provider ping. |
| `/resume` | Session picker by LAST MESSAGE; rebuilds the conversation including the work each turn did. |
| `/compact` | Structured compaction with a before→after token report; persisted. |
| `/context` | Context usage by category; `/context all` expands the tree. |
| `/sandbox` | Cycle the sandbox posture (shift+tab also). |
| `/bg <prompt>` | A turn in the background: a real session, continuable. |
| `/exit` | Leave (daemons stop with you). |

**Twenty-three verbs were absorbed** into the commands above. They are not hidden aliases:
the capability moved, and typing an old name says where it went and what to run outside the
app. `/help moved` prints the map. Full table in [`repl.md`](./repl.md).

> Chatting plain text both converses AND uses tools (one governed agent loop); there is no
> separate `/do`. Evolution runs every turn, so there is no separate `/evolve`. The sigil is
> folded into `/persona`.

> **Everything is reachable from inside the app**, and everything is reachable WITHOUT it:
> each capability is a view in the session and a non-interactive subcommand for agents and CI.
> The
> daemons (`/serve`, `/watch`) run **in the background** so they don't block the app (stop them with
> `/serve stop` / `/watch stop`, or `/exit`). **Any other CLI subcommand** also works as `/<name> …`:
> the REPL passes it through to `personaxis <name>` and echoes the output (`/spec`, `/export`,
> `/decompile`, `/diff`, `/orchestrate`, `/team`, `/skills`, `/scan`, `/personas`, `/migrate`,
> `/push`, `/pull`, …). `/init <name>` scaffolds a **sub-persona** (the root already exists in-session).
> `observe` has no `/` because the living loop already runs a governed tick **every turn**. Same engine
> either way: the terminal `personaxis <cmd>` and the in-app `/<cmd>` are two doors to one engine.

**Multi-persona** (not slash-commands): address sub-personas inline with `@slug …` or
`@all …`. See [multi-persona](../architecture/multi-persona.md). New feature docs:
[memory](../architecture/memory.md), [sessions](../architecture/sessions.md),
[self-evolution](../architecture/self-evolution.md), [awareness](../architecture/awareness.md),
[sandbox](../architecture/sandbox.md).
