# Changelog

All notable changes to the `personaxis` CLI are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] — Fase 3 living engine (per `ARCHITECTURE_REVIEW.md` §11–§13, tracked in `IMPLEMENTATION_CHECKLIST.md`)

### Changed — compile is now a deterministic two-stage pipeline (F3.1)
- **Stage 1 — deterministic assembler** (`@personaxis/core` `assemblePersonaDoc`): `personaxis compile`
  now ALWAYS first assembles the canonical, second-person persona-prompting document from the spec
  with NO model — verbatim voice exemplars, hard limits, and resource manifest, and never any numeric
  runtime state. The same spec produces byte-identical output, so the compiled-doc hash is finally a
  meaningful provenance signal.
- **Stage 2 — optional LLM polish, faithfulness-gated**: when a model provider is configured, an LLM
  rephrases the assembled document (new rephrase-not-add polish prompt). A deterministic faithfulness
  check (`checkFaithfulness`) diffs the polish against the assembled ground truth over four protected
  claim classes and REJECTS a polish that drops a hard limit or invents a claim — the historical CMO
  regression (invented `consistency` items) now fails closed. On rejection, no provider, or `--no-polish`,
  compile writes the deterministic document. Compile no longer requires a model to produce a correct doc.
- The Living Loop's `recompile` hook can now perform a cheap, provider-free inline recompile via the
  same assembler; the `observe`/daemon path gets it for free through the stage-1 fallback.

### Changed — host placement is a core plugin registry; `.dist/` slices (F3.2)
- **Placement moved to `@personaxis/core`** as a plugin registry (`registerTarget`/`getTarget`/
  `placeForTarget`) with the four built-in hosts (claude-code, codex, openclaw, hermes) — so a
  backend (the SaaS) can place documents server-side, not only the CLI. The CLI's `placement.ts` /
  `soul-md.ts` are now thin shims; behavior and the `--platform` flag are unchanged. SOUL.md hosts
  (openclaw/Hermes) re-read the file fresh every message, so a recompile hot-reloads with no restart.
- **`.dist/` consumer slices**: a root compile now also emits `.personaxis/.dist/PERSONA.hot.md`
  (the always-load essentials — opener, voice, always/never anchors, and the hard limits, which are
  never dropped) and `PERSONA.cold.md` (the full document). Deterministic, ephemeral, gitignored.

### Added — `state rebuild`: state.json as a checkpoint of the log (F3.4)
- **`personaxis state rebuild`**: `state.values` is a derived checkpoint of the append-only
  `mutation_log`. `rebuild` replays the log (each entry stores its authoritative post-governance
  result) to detect DRIFT — a stored value the log does not justify (a torn write or a hand-edit) —
  and `--write` repairs state.json from the log, under the state lock. Safe by design: the log is
  authoritative only over the fields it mutated, so an untouched value is never reset.

### Added — storage ports, the persistence seam (F3.3)
- **Hexagonal storage ports** (`@personaxis/core` `ports/`): `LockProvider`, `StateStore`,
  `MemoryStore`, `LedgerStore` (the append-only hash-chained episodic ledger), and `ModelClient`,
  bundled as `Storage` with a `defaultFsStorage()` reference adapter. The `LivingLoop` accepts an
  optional `storage` (fs by default) and routes its state read→apply→write and its memory/ledger
  operations through it — so the SaaS can host the SAME engine over Postgres/S3 by swapping the
  bundle. No behavior change locally; the fs adapter wraps the existing atomic writes + per-persona
  lock.

## [Unreleased] — Fase R replatform (per `ARCHITECTURE_REVIEW.md` §15 + `docs/architecture/TECH_STACK.md`, tracked in `IMPLEMENTATION_CHECKLIST.md`)

### Added — platform (FR.1–FR.3)
- **`docs/architecture/TECH_STACK.md`**: the definitive stack decision record (12 sections,
  evidence from the Claude Code / Codex / OpenClaw+Hermes source studies).
- **`@personaxis/protocol`** — eighth package: `Op`/`EventMsg` discriminated unions over
  JSON-RPC 2.0 (vscode-jsonrpc + node:net; UDS / Windows named pipes, deterministic per-persona
  pipe path), `ProtocolServer` with a hello handshake as registration barrier, subscribe-before-
  connect `ProtocolClient`; the CLI's `EngineHost` binds the core engine 1:1 onto the seam so
  TUI/headless/MCP/serve share one boundary.
- **TUI on Ink 7**: `@personaxis/tui` gains a `./ink` export — `<Sigil/>`, `<AuraBar/>`,
  `<EnvelopeBars/>` (visual.ts preserved verbatim as pure-string components), `<Transcript/>`
  (`<Static>` scrollback + bounded live region), newline-gated commit queue with fence atomicity
  and table holdback (Codex streaming pattern), marked-terminal markdown + lazy shiki + jsdiff,
  zustand vanilla store with frame-batched tokens. `personaxis dash` interactive path now renders
  through Ink.

### Fixed — FR.V verification findings
- **`personaxis-dash` bin moved to a dedicated entry** (`dist/bin.js`): the main-module guard in
  the tui barrel (`import.meta.url === argv[1]`) fires spuriously for every module inside a
  bun-compiled binary (shared virtual root), launching the dashboard on EVERY CLI invocation.
  Rule adopted: bins get dedicated entry files, never barrel guards.
- **bun-compile verified on 3 targets**: Windows x64 built and executed (`--version`, golden CMO
  `validate` exit 0, `dash --once`); linux-x64 + darwin-arm64 cross-compiled. Packaging note:
  ink's optional `react-devtools-core` must be bundled (root devDependency) — `--external`
  fails eagerly inside the binary.

### Added — engine extensibility & safety (FR.4–FR.10)
- **Hooks v2 (shell-out)**: `.personaxis/hooks.json` runs user executables on 6 events
  (PreToolUse/PostToolUse/UserPromptSubmit/Stop/SessionStart/SessionEnd) — JSON payload on stdin;
  exit 0 = ok, exit 2 = block, other = warn; optional `{"decision":"block"}` on stdout; blocking
  events are timeout-bounded and fail OPEN to warn; the rest are fire-and-forget. PreToolUse veto
  gates the agent loop before the sandbox gate.
- **Config layers**: explicit numeric precedence (managed 0 → global 10 → project 20 → persona 25
  → frontmatter 28 → env 30) with attributable winners, plus `resolvePolicyTier()` where the
  STRICTEST layer wins regardless of rank (generalized min-wins governance).
- **Sessions**: background `SessionWriter` (ordered queue drain, `flush()`/`shutdown()` acks),
  automatic `parent_uuid` threading, derived rebuildable `sessions/index.json` (JSONL stays the
  source of truth; no SQLite by decision — bun-compile forbids native addons).
- **Tools registry v2**: `isReadOnly`/`isConcurrencySafe` flags + `validateToolArgs()`
  (JSON-Schema — an explicit no-new-dep decision instead of Zod).
- **Permissions v2**: `writableRoots`, protected subpaths (`.git/hooks`, `.personaxis`) that an
  allow-list can never override, per-category approvals (network/destructive/write,
  strictest-wins), named profiles `strict|standard|trusted|yolo`.
- **`ApprovalBroker`** (request→deliver→await→gate; expiry fails CLOSED to deny) wired to the
  protocol `approval` op, and **tool-call repair** (OpenClaw port: fences, prose, single quotes,
  unquoted keys, trailing commas, truncation) on both tool-call parse paths.
- **Credentials**: `personaxis credential set|get` — env-first resolution with OS secure storage
  via shell-out only (macOS Keychain `security`, Linux `secret-tool`; value read from stdin,
  never argv; keytar forbidden). Windows stays env-only until a DPAPI helper ships with the
  signed binary (documented assumption). BYOK keys resolve through it.
- **Update hint**: zero-dependency daily npm dist-tags check (cached, never blocks or throws;
  `PERSONAXIS_NO_UPDATE_CHECK=1` and CI disable it) — an explicit deviation from update-notifier
  for supply-chain surface reasons. Binary self-updater + Windows code-signing land with the
  bun-compile release infrastructure.

## [Unreleased] — F2 SPEC v1.0 support (per `ARCHITECTURE_REVIEW.md` §11, tracked in `IMPLEMENTATION_CHECKLIST.md`)

### Added — spec v1.0 (breaking spec release; the CLI reads BOTH)
- **Dual-schema validator with version dispatch**: v1.0 documents (`spec_version: "1.0.0"`)
  validate against the rewritten `schema/persona.schema.json`; 0.3.0–0.10.0 documents keep
  validating against the frozen `schema/legacy/persona-0.10.schema.json` (read-compat window).
  Universals run unconditionally with the version-correct paths (`self_regulation` vs
  `reflexive_self_regulation`; `apiVersion` `personaxis.com/v1` vs `persona.dev/v1`). New v1
  coherence check: a hard-enforced virtue whose `refs:` point at a trait envelope that permits
  contradiction is FAIL_POLICY.
- **`migrate 0.10-to-1.0`** — the first STRUCTURAL codemod (comment-preserving, dry-run default,
  written report): renames `reflexive_self_regulation` → `self_regulation` (layer 9 +
  `per_layer_edit_policy` + `drift_thresholds`); merges `persona_prompting` into layer 10
  `persona` and its `break_character_guardrails` into `self_regulation.hard_limits`; merges
  `principled_refusals` into `character.prohibited_behaviors` (two refusal surfaces); moves
  `memory.retrieval_policy` knobs + `deletion_policy.retention_days_default` to the new
  `runtime.memory` block; converts bare drive `intensity` to the nearest static `level`
  (a drive is mutable only by declaring a `{mean, range}` envelope); drops
  `metadata.display_name`; bumps `apiVersion`/`spec_version` (policy.yaml too); renames sibling
  `state.json` value keys to full dot-paths.
- **`resolveField` (core)**: every mutation entry point (`state mutate`, HTTP `/persona/adjust`,
  MCP `adjust_persona_state`, SDK `adjust`) accepts BOTH the short (`mood.tone`) and full
  (`affect.baseline.mood.tone`) field form and resolves onto the persona's canonical envelope
  key — v1 personas use full dot-paths natively; 0.x personas keep short keys.
- v1 envelope extraction: full dot-path keys, envelope-declaring drives join the mutable surface,
  and `protectedFields` covers hard virtues' names AND their `refs`.
- **`@personaxis/spec`** — new seventh package: the canonical JSON Schemas (v1.0 + frozen
  `legacy/persona-0.10` for the 1.x read-compat window), the five-state validator with version
  dispatch, and the 12 universals, embedded at build (bun-compile safe). The CLI's `schema.ts`
  is now a shim; `packages/cli/schema/` moved to `packages/spec/schema/` (single monorepo copy;
  CI byte-identity gate re-pointed).
- **Memory erasure (D6)**: new entries are `content_hash`-anchored; `redactMemory()` performs
  REAL erasure (bytes gone, chain still verifies, audited via tombstone record);
  `migrateMemoryChain()` re-anchors legacy logs (remapping tombstone targets); chain verification
  is dual-format. `STATE_SCHEMA_VERSION` → 1.0.0.
- **`improvement_policy` min-wins precedence (SPEC.md §7.2)**: `readMode(frontmatter, personaPath?)`
  composes the authoritative inline mode with a sibling policy.yaml that can only RESTRICT it
  (legacy `auto` normalizes to `autonomous`); wired at the Living Loop, MCP, REPL, `state mutate`
  and `improve` call sites.
- **`personaxis init` scaffolds are v1.0** (all four builders migrated via the codemod itself;
  scattered pre-0.6 `edit_policy` and bare affect scalars fixed) and a new test proves every
  scaffold validates as 1.0.0 — which surfaced and fixed a latent defect: the UserPersona scaffold
  had NEVER validated (the schema now requires the full anatomy only for `kind: AgentPersona`,
  the D9 explicit subset).
- Codemod hardening: strips stray layer-level `edit_policy`, wraps bare core_affect/mood scalars
  into degenerate envelopes (with a widen-me follow-up). `validate` banner prefers
  `identity.display_name`.

## [Unreleased] — F1 hardening (per `ARCHITECTURE_REVIEW.md` §9, tracked in `IMPLEMENTATION_CHECKLIST.md`)

### Fixed — governance & integrity
- **`state mutate` now goes through the real governance gate** (F-02): the duplicated mutation
  engine in `commands/state.ts` (with its permanent `governanceBlocked = false` stub) was deleted;
  the command uses core's `extractEnvelopes`/`governMutations`/`applyMutation`. Core's
  `GovernanceConfig` gains `humanDirected`: deliberate `--actor human-operator` mutations bypass
  the mode lock and drift bound (the gate's documented intent), while non-human actors are subject
  to `improvement_policy.mode` and `max_step_delta`; traits backing hard-enforced virtues are
  immutable for every actor; a governance refusal is itself recorded in `mutation_log`
  (`governance_blocked: true`) and exits 2 naming the exact rule.
- **Same-machine concurrency control** (F-03): `writeState` is atomic (temp+rename) and every
  read→modify→write site takes a per-persona lock (`core/src/lock.ts`: mkdir lock dir, PID +
  stale-steal, loud 5s timeout) — Living Loop apply, agent persist, HTTP `/persona/adjust`, MCP
  `adjust_persona_state`, SDK `adjust`, and `ensureState` seeding. The lock is never held across
  a model call.
- **MCP server hardening** (F-07, ADR-011): every persona/skill path is confined to `--root`
  (default: the server's cwd) — escaping paths are rejected; `persona_decide_edit` is disabled
  unless the human launching the server passes `--allow-decide` (proposer≠approver).
- **Hermes hooks installer rewritten** (F-23): the previous installer wrote a
  `hooks.on_session_end` stanza into `~/.hermes/config.yaml` — a shape Hermes never reads. It now
  installs Hermes' real mechanism: `~/.hermes/hooks/personaxis-observe/{HOOK.yaml, handler.py}`
  subscribed to **`agent:end` (per turn)**; install/uninstall also clean the legacy stanza.
  `docs/integrations/hermes.md` corrected (including that `agent:end` IS a per-turn event).

### Fixed — release & versions
- **`release.yml`**: hand-ordered publish loop (which omitted `@personaxis/sdk` and swallowed
  failures with `|| echo`) replaced by topological `pnpm -r publish`; npm provenance enabled.
- **Version single-sourcing** (F-26): `CORE_VERSION` is generated from `core/package.json` at
  build (`core/scripts/gen-version.mjs`); `ensureState` seeds `STATE_SCHEMA_VERSION` (`0.9.0`,
  the state schema's current value) instead of a stale literal; the MCP server reports its own
  package version; the cli package description said "spec v0.8.0" — now v0.10.0.

### Security
- **pnpm supply-chain hardening** (F1.9): `minimumReleaseAge: 2880` (48h) and an explicitly empty
  `onlyBuiltDependencies` allowlist in `pnpm-workspace.yaml`.

### Docs
- CLAUDE.md corrections: evals categories are **governance/security/spec-fidelity** (no "honesty"
  category exists), migrate codemods listed through `0.9-to-0.10`, MCP row reflects the 16 tools +
  `--root`/`--allow-decide`; evals package description no longer claims an "optional live" mode.
- Added `ARCHITECTURE_REVIEW.md` (the master architecture audit + v1.0 design reference) and
  `IMPLEMENTATION_CHECKLIST.md` (persistent execution state).

---

## [0.11.0] - 2026-06-29

Runtime/correctness release (no spec field changes; `spec_version` stays `0.10.0`). Closes the
gap between what the spec declared and what the runtime actually did.

### Added — host targets openclaw + Hermes (2026-07-01)
- **`compile --platform openclaw` and `--platform hermes`** — both hosts read `SOUL.md` as the first
  system-prompt section, so compile writes the compiled qualitative identity as `SOUL.md` (openclaw:
  workspace-root; Hermes: `.hermes/SOUL.md`), stripping the subagent frontmatter. Root and sub-personas
  supported; SOUL.md hosts skip the `@PERSONA.md` baseline injection. `PLACEMENT_PLATFORMS` is now
  `claude-code | codex | openclaw | hermes`. The four focus hosts are all live.
- **Compile now uses the layered config too**: the `local` provider resolves its endpoint/model/key via
  `resolveModel` (env > project > global, `apiKeyEnv`) — so `config set --global local.*` drives compile,
  not just the REPL (closes a dev/loop-vs-compile inconsistency).

### Added — living engine, config & UX (2026-07-01)
- **Event-driven living engine**: `personaxis observe` runs ONE governed tick on the configured model
  and recompiles `PERSONA.md` on drift (`--stdin` reads a Claude Code Stop-hook payload; `--strict`/
  `--json` for programmatic hosts). `personaxis hooks install --host claude-code` wires a Stop hook so
  every turn feeds a tick **on your model, not the host's**. `personaxis watch` is an optional local
  daemon (recompile on manual spec edits + a drift heartbeat; `--once` for serverless cron/CI).
- **`@personaxis/sdk`** — embed a living persona in a Node/TS backend (`class Persona`:
  `compiledIdentity`/`state`/`observe`/`adjust`/`audit`). Modo 2 self-host.
- **Layered model config** (no more env exports per launch): `resolveModel` resolves env > project >
  global (`~/.personaxis/config.json`) with per-persona overrides (`personas[slug]` or frontmatter
  `runtime`). API key resolves from the env var named by `apiKeyEnv` → `PERSONAXIS_API_KEY` → inline
  (dev). `config set --global`, `/model set` in the REPL, and a first-run setup hint. REPL/`serve`/MCP
  all use it.
- **`/compact` persists**: a summary checkpoint survives `/resume` (no re-compacting after re-entering).
- MCP server version → 0.11.0.

### Fixed — sandbox & UX (2026-07-01)
- **Sandbox postures now meaningfully differ**: `danger-full-access` allows risky ops without asking
  (YOLO; deny-list still wins) — previously it still prompted like `workspace-write`. Changing the
  posture mid-session now nudges the model to re-evaluate (it retries instead of parroting a prior
  refusal from history).
- **Per-turn telemetry** renders as a distinct labeled block (memory used/created, evolution,
  evaluations), and `/` commands are visually separated from the reply.

### Added
- **Persistent sessions** per persona under `.personaxis/[personas/<slug>/]sessions/<id>.jsonl`;
  `/sessions` lists them and `/resume <id|name>` continues one. Auto-named from the first message.
- **Whole-spec self-evolution in the live loop**: each turn the appraiser may propose governed
  self-edits to **any** spec section (not just `persona_prompting`) — quantitative, qualitative,
  or any other layer — except the protected safety floor. Editability is decided by `editGate`,
  composing the protected floor + the author's declared `governance.per_layer_edit_policy.<layer>`
  + the global `improvement_policy.mode` (`locked` blocks, `suggesting` queues for `/review`,
  `autonomous` auto-applies; a layer marked `human_approval_required` is queued even in autonomous).
  All gated by consensus verifiers + protected paths + a `user`-trust provenance gate. New `/review`
  command. The appraiser prompt now teaches the exact `{ targetPath, toValue, rationale }` shape so
  real models reliably emit structured self-edits instead of prose.
- **All six `memory.types` enforced**: `procedural`, `autobiographical`, `user_preferences`,
  `evaluations` are implemented (were declared-but-unenforced); each producer honors its flag.
- **Real per-turn observability**: new `memory-recall` (memory *used* to answer: kind+count+snippet)
  and `evaluation` (target+dimension+score+rationale) bus events. The per-turn summary now shows
  `recalled episodic×2 (…) · memory +1 episodic (…) · evaluated #hash usefulness 0.74` instead of an
  opaque `+N eval(s)`. `/state` shows the **whole mutable surface** (envelopes + applied self-edit
  overlay + pending proposals); `/memory` lists all six kinds; `/audit` adds the self-edit ledger +
  recent evaluations.
- **Runtime structure awareness**: the system prompt states whether a persona is root or a sub,
  its address, its sub-persona tree, and its `.personaxis/` resource inventory.

### Changed
- `PERSONA.md` is now purely qualitative: the numeric `LIVE-STATE` block is no longer injected
  into the compiled doc (state lives in `state.json`/`.live.json`); old blocks self-heal.
- `/persona` absorbs `/sigil` (role, sub-personas, resources, mode, posture, sigil).
- Compile prompt: one-source-per-fact + no numeric state.
- Reply format `‹glyph› Name ›  text` so it is clear who spoke.

### Removed
- Redundant REPL commands `/do` and `/evolve` (plain chat already uses tools; every turn already
  runs a governed tick).

### Fixed
- **Conversation turns**: assistant replies are now persisted into the transcript before returning,
  so the next turn carries them — fixes the bug where the agent re-answered every prior question
  each turn instead of only the current one.
- **"Stuck thinking" hang**: a self-edit no longer triggers a blocking full LLM recompile on every
  turn (it marks `PERSONA.md` stale → `/compile`); the LLM appraiser has a 30s request timeout so a
  hung endpoint never blocks a turn.
- No-op mutations (`0.98→0.98`) are no longer printed as "evolved".
- Delegation no longer writes episodic memory when `memory.types.episodic` is `false`.

### Docs
- New [docs/CONCEPTS_FAQ.md](docs/CONCEPTS_FAQ.md): a single navigable answer to the common
  conceptual questions (compile/decompile, sub-personas, what self-evolves and who decides, the
  modes, the six memory kinds, sessions, the sandbox, every REPL command).

---

## [Unreleased]

### Added

- `compile [<slug>] [--root] [--platform <p>]` command: compile `.personaxis/[personas/<slug>/]personaxis.md` to `PERSONA.md` (root) or `<slug>.md` (subagent) via the configured provider (`local | byok | agent | remote`).
- `decompile [<slug>] [--root]` command: hand-edited `PERSONA.md`/`<slug>.md` -> proposed `personaxis.md`, validated before writing.
- `push [--root|<slug>]` command: validate, sync `personaxis.md` <-> compiled doc, and publish a new `AgentPersonaVersion`.
- `pull [--root|<slug>] [--version vX.Y.Z]` command: fetch a persona version's spec, compiled doc, and resource bundle into local layout.
- `state init` command: create `state.json` beside `personaxis.md`, seeded from envelope means.
- `state mutate --field <path> --delta <n> --reason <text>` command: adjust a current value, clamped to envelope, with audit log.
- `state show [--json]` command: pretty-print current state, active context, and recent mutations.
- `migrate 0.5-to-0.6 [<file>] [--apply]` command: structural codemod with written report (governance unification, envelope format, reflexive decisions).
- `migrate 0.6-to-0.7 [--apply]` command: layout-only codemod (root `PERSONA.md` -> `.personaxis/personaxis.md` + PERSONA.md recompile).
- `skills list [--root|<slug>]` command: list `extensions.skills` entries and their materialization status.
- `skills pull <name> [--root|<slug>]` command: pull a `github:org/repo[/path]` skill entry into `skills/<name>/`, validate against agentskills.io rules, and rewrite entry to local path.
- `config set provider <local|byok|agent|remote>` command: configure the provider used by `compile`/`decompile`/self-improvement.
- `decompile` command: registered alongside `compile` in the command index.
- `template list|show|get` commands for managing pedagogical templates.
- `spec` command: print the v0.7.0 spec for injection into agent prompts.
- Provider implementations: `local`, `byok`, `agent`, `remote` (see `src/providers/`).
- `src/resource-manifest.ts`: `buildResourceManifest` -- builds capped resource manifest for compile/decompile prompts without inlining file contents.
- `src/compile-instructions.ts`: prompt templates for `compile` (forward) and `decompile` (reverse).
- `src/targets/skills.ts`: resolve `extensions.skills` entries, materialize local skills to platform discovery dirs, write `skills-manifest.json`.
- `src/manifest.ts`: `manifest.json` tracking compile/decompile provenance and content hashes.
- Skills materialization in `compile`: local skills copied to `.claude/skills/<name>/` (claude-code) or `.agents/skills/<name>/` (codex); `skills-manifest.json` written beside `personaxis.md`; `skills:` preload field injected into Claude Code subagent frontmatter for non-empty skill lists; `Skill` added to `disallowedTools` for subagents with no declared skills.
- Codex subagent `[[skills.config]]` blocks generated by `compile` for per-subagent access control.

### Changed

- `spec_version` validator now accepts `"0.3.0"`, `"0.4.0"`, `"0.5.0"`, `"0.6.0"`, and `"0.7.0"` (was hardcoded to `"0.3.0"` or `"0.4.0"`, causing all modern personas to emit a lint error).
- All `init` templates updated from spec v0.5.0 to v0.7.0: removed scattered `edit_policy` from individual layers, removed `drift_threshold` from personality, converted `affect.baseline.core_affect` values to `{mean, range}` envelopes, changed `reflexive_self_regulation.actions: []` to `decisions: {}`, added full `governance` block with `per_layer_edit_policy`, `drift_thresholds`, and `improvement_policy_location`.
- `init` baseline mode now creates `.personaxis/personaxis.md` (quantitative spec) instead of root `PERSONA.md`; user runs `compile --root` to produce the compiled qualitative document.
- `init` agent mode now writes `personaxis.md` (not `PERSONA.md`) inside `.personaxis/personas/<slug>/`.
- `init` user mode now writes `personaxis.md` (not `PERSONA.md`) inside `.personaxis/user-personas/<slug>/`.
- `policy.yaml` template updated from spec v0.5.0 to v0.7.0.
- `compile` hints in `init` output updated from `--target` to `--platform` flags.
- `.personaxis/personaxis.md` (this repo's own baseline): migrated from v0.6.0 to v0.7.0 -- removed scattered `edit_policy` and `drift_threshold`, converted `affect.baseline.core_affect` to envelopes, changed `reflexive_self_regulation` to `decisions:{}` format, expanded `governance` block with `per_layer_edit_policy`, `drift_thresholds`, `improvement_policy_location`.
- `use` command output file changed from `PERSONA.md` to `personaxis.md` (correct v0.7.0 quantitative spec filename); compile hints updated to `--platform`.
- `compile` command: replaced legacy `--target` flag and `runLegacyTargetExport` with `--platform` and `runCompile`; added skills materialization pipeline.
- `CLAUDE.md` golden test paths corrected to `../persona.md/.personaxis/personas/cmo/personaxis.md`; `src/targets/runtime-skills.ts` reference replaced with `src/targets/skills.ts`.
- `AGENTS.md` golden test paths corrected to `../persona.md/.personaxis/personas/cmo/personaxis.md` and `state.json`.
- `README.md`: badge updated to spec-0.7.0; title updated to "spec v0.7.0 / Personaxis v12"; added `migrate 0.6-to-0.7` to migration examples; commands table corrected; "Compile platforms" section replaces "Compile targets"; "v0.7 three-artifact model" section added.
- `package.json` description updated to v0.7.0/Personaxis v12 with correct three-artifact model and command list.

### Removed

- Removed pre-0.7.0 `--target`/`use` legacy skill export; `personaxis compile [slug] --platform <platform>` covers this with v0.7.0 resource names and now also materializes declared skills (see `personaxis skills`).
- Removed `src/targets/runtime-skills.ts` (legacy, pre-v0.6 resource names); replaced by `src/targets/skills.ts`.
- Removed `extensions.knowledge_anchors` support (deprecated in v0.6; redundant with `references/`).
- Removed scattered `edit_policy` fields from individual layers in all `init` templates (consolidated into `governance.per_layer_edit_policy` per v0.6 spec).

### Fixed

- Linter `spec_version` check no longer rejects all v0.5+/v0.6+/v0.7+ personas.
- `use` command no longer writes `PERSONA.md` (v0.5 name) as the quantitative spec output; now correctly writes `personaxis.md`.

---

## [0.6.0] - 2026-05-18

_(initial published version, spec v0.6.0 / Personaxis v11)_

- Baseline validator, linter, `init`, `validate`, `lint`, `list`, `templates`, `diff`, `export`, `spec`, `use` commands.
- Five-state validator (`PASS`, `PASS_WITH_WARNINGS`, `FAIL_SCHEMA`, `FAIL_POLICY`, `FAIL_CONCEPTUAL`) with exit codes 0/0/1/2/3.
- Twelve universal invariants enforced in `src/schema.ts`.
- Lint rules in `src/linter/rules.ts` with tier-aware `MUST`/`SHOULD`/`MAY` findings.
- `init` templates: project baseline, marketing-guru, custom agent, user persona.
- Compile targets: Claude Code (`src/targets/claude-code.ts`), Codex (`src/targets/codex.ts`), with CLAUDE.md/AGENTS.md baseline injection.
