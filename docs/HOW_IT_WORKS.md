# Personaxis: what it is and how it works

> Functional reference. For the theorem-to-code map see
> [`architecture/math-core.md`](./architecture/math-core.md); for the evidence scoreboard see
> [`GUARANTEES.md`](./GUARANTEES.md).

## 1. What it is (and what things are called)

**Personaxis** is the *toolchain for living, governed AI personas*. It is not an agent that
competes with Claude Code, Codex, or Hermes: it is the layer of **living, portable, auditable
identity** you can give them, or that can run on its own over a local model.

Names:
- **Product / repo:** `personaxis`.
- **CLI binary:** `personaxis`.
- **TUI binary:** `personaxis-dash`.
- **MCP server binary:** `personaxis-mcp`.
- **npm packages (monorepo):** `@personaxis/core` (engine), `personaxis` (the CLI),
  `@personaxis/mcp`, `@personaxis/sdk` (embed in a backend), `@personaxis/tui`, plus `@personaxis/spec`,
  `@personaxis/protocol`, `@personaxis/evals`.

> **How is it used in practice?** There are two modes (local development companion vs a runtime
> persona inside an app) and four surfaces (library/SDK, HTTP `serve`, MCP, `watch` daemon). The
> "always alive" behavior comes from host **hooks** that fire `personaxis observe` on YOUR model
> per turn (spending no host tokens). See [architecture/deployment.md](./architecture/deployment.md),
> [guides/configuration.md](./guides/configuration.md), and [CONCEPTS_FAQ.md](./CONCEPTS_FAQ.md).

The core idea: a persona can **adapt** to the user and the context without ceasing to be safe,
because **every evolution is clamped, audited, and reversible**, and the **spec's universal
invariants are inviolable**. That governance, not raw self-improvement, is the differentiator.

## 2. The three-artifact model

A persona is described by three files (spec `personaxis.md` v1.1):

| Artifact | What it is | Mutability |
|---|---|---|
| `.personaxis/personaxis.md` | **Quantitative** identity: 10 layers, *envelopes* `{mean, range}`, invariants | Immutable (except through a governed flow) |
| `PERSONA.md` / `.claude/agents/<slug>.md` | **Qualitative** compiled identity (prose), the system prompt's slot #1 | Generated (`compile`); hand-editable (`decompile`) |
| `state.json` | **Mutable** runtime state: current values + `mutation_log` | Mutates via the `adjust_persona_state` tool, clamped to the envelopes |

The 10 layers: identity, character, personality, values_and_drives, affect, cognition, memory,
metacognition, self_regulation, persona. Each mutable field (traits, affect, mood) declares an
*envelope* `mean + [min,max]`; the current value lives in `state.json` and can **never** leave
its range.

## 3. The Living Loop (what makes it "alive")

You start the REPL with just `personaxis` (no subcommand). You chat in natural language or use
`/commands`. Each turn feeds a **governed loop**:

```
observe   → capture a signal (user input, tool output, reflection)  [with provenance]
   ↓        + injection scan (malicious text does not drive evolution)
appraise  → the model proposes ONLY structured signals (JSON-schema), not raw mutations
   ↓
evolve    → the spec's code applies the CLAMPED delta to the envelope + governance gate
   ↓        + an immutable mutation_log entry
recompile → ONLY if a coordinate CROSSED a behavior band (the normative event, spec §15):
   ↓        within-band movement = expression variance, no recompile; the crossing
   ↓        rewrites the compiled doc (live-sync) + .live.json marker + `drift` event
   ↓
memory    → writes to episodic memory (append-only, hash-chained) after verifying the chain
```

**Safety split:** the model (even a small one, 4B or less) only *proposes*; the code and the
spec *enforce* safety. That is why it is viable on small models and safe at the same time.

### The Agent Loop (run tasks, not just evolve)

Alongside the Living Loop (which evolves the **identity**) runs the **Agent Loop** (which
executes **tasks**). In the REPL there is no separate command: **speaking in natural language**,
the persona converses AND uses tools in a single governed loop:

```
task → [ the model proposes a tool (run_command / read_file / write_file / edit_file / list_dir)
         → sandbox GATE (allow | ask | deny) → (if ask) human approval → run → observe ]*
       → finish
```

The model **only proposes** the tool call; the **sandbox decides** (a `deny` never runs), risky
actions **ask for approval** (`shift+tab` cycles the posture: `read-only → workspace-write →
danger-full-access`), and **every tool output is scanned for injection** before returning to the
model. It uses the provider's native function-calling with a fallback to constrained JSON
(provider-agnostic). The same agent is exposed over MCP (`agent_run`) and HTTP (`POST
/persona/agent`).

The evolution mode is decided by the spec's `improvement_policy.mode`:
- `locked` (default): the loop appraises and remembers, but envelope mutations are human-directed only.
- `suggesting`: the actor proposes self-edits that enter a human approval queue.
- `autonomous` (sandbox only): applies directly, bounded by invariants + verifiers.

## 4. Governance and security (the *moat*)

- **Machine-checked mathematical guarantees (v1.1):** the envelopes form a compact box B; the
  clamp is the projection Π_B. Theorems T1–T6 (map in
  [`architecture/math-core.md`](./architecture/math-core.md)): no adversarial sequence escapes B
  (T1), bounded step (T2), crossing a behavior band costs a provable minimum of hash-chained
  audit entries (T3), deterministic replay + located tampering (T4/T5), opt-in homeostasis with
  bounded standing drift (T6). Verified against 2.3M generated adversarial cases, 0
  counterexamples ([`GUARANTEES.md`](./GUARANTEES.md)). `personaxis proof` shows it live; `state
  drift` computes where the persona sits vs `governance.drift_thresholds` (a CI gate, exit 2).
- **Envelopes + clamping:** no value leaves its declared range.
- **Universal invariants (12):** the validator enforces them; a `personaxis.md` that fails does
  not compile. Output uses 5 exit codes.
- **Governed memory:** episodic *append-only* with **provenance** (user/tool/internal/synthesis)
  and a **hash chain** (detects tampering). Deletion on request via *tombstone* (does not rewrite
  history; the redaction is auditable). The runtime **respects the spec's `memory.types`**: with
  `episodic: false` it writes nothing; with `semantic: true` it consolidates to `memory.md`. The
  **six types** are implemented and each producer honors its flag (episodic, semantic,
  procedural, autobiographical, user_preferences, evaluations).
- **Injection/poisoning defenses:** layered injection scanner (Unicode normalization, zero-width,
  bidi, homoglyphs; base64/hex decoding; weighted rules); anomaly detection with multi-path
  consensus; *sensitive-action gates* by provenance.
- **Governed self-evolution:** `propose/apply/revert`, protection of invariant fields, version
  minting, and **multi-agent consensus** (a quorum of verifiers) before applying.
- **Command sandbox:** two-axis policy engine (approval × sandbox) → `allow|ask|deny`, with a
  best-effort native wrapper (Seatbelt/bubblewrap). A `deny` command does not run.

## 5. Commands (reference)

**The live one:**
- `personaxis` opens the **REPL** (a live session). In a TTY it is a **full-screen app**
  (alternate-screen, no frame history left behind): a live `/` palette and `shift+tab` to cycle
  the sandbox posture. Commands: `/persona`, `/state`, `/improve`, `/review`, `/compile`,
  `/audit`, `/memory`, `/sessions`, `/resume`, `/compact`, `/goal`, `/loop` (runs governed
  ticks), `/mode`, `/model`, `/drift` (u/band/T3-cost report), `/arbitrate` (value conflicts),
  `/replay` (animated history + T4 verdict), `/dash`, `/proof`, `/create`, `/overseer`, `/help`,
  `/exit` (the sigil is inside `/persona`; there is no `/do` or `/evolve`: talking already uses
  tools and evolves every turn). In a pipe/CI it degrades to a plain reader.
- `personaxis sigil [--persona <path>]`: the persona's unique ASCII sigil + envelope panel.
- `personaxis-dash [--persona <path>]`: a live TUI that breathes with the state.

**Orchestration / environment:**
- `personaxis overseer show|register|collection`: the master view of all personas, projects, and
  collections (in `~/.personaxis`).
- `personaxis orchestrate "<task>" [--run]`: routes a task to the best-matched persona
  (capability blackboard); `--run` runs one loop cycle on the assignee.
- `personaxis sync <other-state.json> --persona <path>`: reconciles another machine's `state.json`
  without clobber (audited merge).

**Interop:**
- `personaxis serve --persona <path>`: HTTP server + `agents.md` (for agents that do not speak MCP).
- `personaxis-mcp`: MCP server (stdio) with 16 persona tools.

**Genesis and proof (v1.1):**
- `personaxis create [slug]`: build a persona from scratch: psychometric interview,
  `--from-prompt`, `--from-project`, `--from-import` (character cards V2/V3, system prompts),
  `--from-transcript`. Valid by construction + a creation report with per-number provenance.
- `personaxis proof [--quick]`: offline demo of the guarantees (adversarial storm, tamper,
  replay, certified crossing cost).
- `personaxis state drift` · `personaxis jacobian` · `personaxis arbitrate`: the drift report (CI
  gate), exact compile sensitivity (decorative numbers), deterministic arbitration.

**Spec toolchain:** `init`, `validate`, `lint`, `compile`, `decompile`, `state`, `migrate`,
`push`, `pull`, `skills`, `diff`, `export`, `spec`, `list`, `config`. (`create` replaces the older
`use`/`templates` scaffolds.)

## 6. Persona reuse (global + overlay)

A persona lives **globally** in `~/.personaxis/personas/<slug>` (identity + accumulated memory).
Each project mounts an **overlay** with its own `state.json` and project memory. So you can:
- **reuse** the same persona with accumulated memory across projects, or
- instantiate it **fresh** per project.

**Teams/Collections** group personas and projects. The **user-clone** (your digital twin) is a
git-versioned persona that can live on Windows/Linux/macOS at once; `sync` reconciles per-machine
state without one overwriting another (identity immutable, only state/memory diverge and merge
with an audit trail).

## 7. Interoperating with large agents (3 paths)

1. **MCP** (`personaxis-mcp`): tools like `persona_compiled`, `persona_state`,
   `adjust_persona_state`, `persona_observe`, `persona_audit`, `persona_propose_edit`,
   `skill_review`, `scan_text`, `evaluate_command`. The host (Claude Code/Codex) brings the
   powerful model; personaxis brings the living identity.
2. **`agents.md` + HTTP** (`personaxis serve`): a low-context contract for agents that do not
   speak MCP (Hugging Face Spaces pattern).
3. **Native subagent**: `compile` to `.claude/agents/<slug>.md`, `.codex/agents/<slug>.toml`,
   `SOUL.md`; **live-sync** updates the host's doc when the persona evolves.

## 7b. Visual identity (differentiated by spec)

Each persona **looks and behaves differently in the terminal**, derived deterministically from
its `personaxis.md` (not a generic spinner). The `PersonaTheme` (`@personaxis/core`) maps:

- **affect.valence → tone** of the palette (cool ↔ warm); **arousal → brightness**.
- **extraversion → rhythm/amplitude** of the "breathing"; **openness → drift** (how much the sigil
  explores between frames); **emotionality → jitter**; **conscientiousness → symmetry** (crisp ↔ organic).
- identity → **glyphs** and a stable seed; **voice** → `terse | balanced | expansive` (output style).

All animation lives in **one place**: `@personaxis/tui/visual` (animated logo, persona "wake-up",
themed animated sigil, live aura, per-event flourishes, voice style). The REPL, the `sigil`
command, and the dashboard all use it. Animations run only in a TTY; in a pipe/CI there is a
static fallback. Two different personas → visibly different sigil, palette, glyphs, and voice.

## 8. Architecture (monorepo)

```
personaxis/                      ← one repo
└── packages/
    ├── core/  @personaxis/core        → engine: envelopes, state-engine, governance, memory,
    │                                     Living Loop, appraisers, sigil, blackboard, sync,
    │                                     live-sync, skills, injection, sandbox, registry
    ├── cli/   personaxis  → REPL + commands (over core)
    ├── mcp/   @personaxis/mcp         → MCP server (over core)
    └── tui/   @personaxis/tui         → ASCII dashboard (over core)
```

The **engine never prints**: it emits events; the UIs (REPL/TUI/MCP/HTTP) render them. This lets
a single core be reused at every entry point (the Codex submit/event pattern).

## 9. Packaging and platforms

TypeScript everywhere. Two distribution channels:
- **npm** (`npm i -g personaxis`), requires Node 20 or newer.
- **Single binary** per platform via `bun compile` (`pnpm run package`), no runtime; the assets
  (schemas/templates/version) are **embedded** at build, so the binary is self-contained.

## 10. Workflows (end-to-end)

> **Key idea:** Personaxis is the *soul + memory + awareness* of the persona. It can operate two
> ways: (a) **as a layer** under a host agent (Claude Code, Codex) that brings the powerful model,
> or (b) **as a standalone agent** that runs tasks itself via the Agent Loop (by speaking in
> natural language), governed by the sandbox. In both cases identity is persistent, evolution
> bounded, and every action audited.

### Flow A: Solo (personaxis without a large agent)

Useful when you want a **governed identity + persistent memory + bounded evolution**, not a
replacement for Claude Code.

1. **Authoring:** `personaxis create` (or `init`/`pull`) → `personaxis validate` (passes the 12
   invariants) → `personaxis compile` (generates `PERSONA.md`).
2. **Life:** `personaxis` opens the REPL. With a local/BYOK model
   (`PERSONAXIS_ENDPOINT`+`MODEL`), you talk to the persona: each turn it **observes → appraises →
   evolves (bounded) → remembers**. Without a model, it uses the heuristic appraiser (demo/offline).
3. **Audit and reuse:** `/audit` (see the trail), `overseer show` (the whole environment), `sync`
   (reconcile across machines).

What it **does** on its own: define/validate/compile the persona, run the governed loop
(reactions + memory + bounded evolution), serve that identity, **and run real tasks** when you
talk: the **Agent Loop** runs commands and edits files, each action gated by the persona's sandbox
(`ask`/`deny`), with output scanned and audited. It needs a model with tool-calling
(`PERSONAXIS_ENDPOINT`+`MODEL`). In `read-only` posture it only reads; in `workspace-write` it acts
inside the project, asking approval for risky steps.

### Flow B: As a layer under a powerful agent (the main case)

The host brings the powerful model and the tool-use loop; personaxis brings living identity + governance.

**B1: Native subagent (no MCP):**
```bash
personaxis compile --platform claude-code   # writes .claude/agents/<slug>.md + a baseline in CLAUDE.md
```
Claude Code adopts that file as the subagent's system prompt → **the agent IS the persona**. When
the persona evolves, `live-sync` rewrites the file's LIVE-STATE block and the host sees it.

**B2: MCP (runtime, richer):** you register `personaxis-mcp` with the host. Typical session:
1. **Start:** the host calls `persona_compiled` → loads the identity (prompt slot #1).
2. **During work, the host calls personaxis as a "conscience":**
   - `persona_observe` → a governed loop tick (the persona reacts/evolves, bounded).
   - `adjust_persona_state` → adjust mood/affect (clamped + audited).
   - `scan_text` → before trusting external content (injection defense).
   - `evaluate_command` → before running a command (sandbox policy: allow/ask/deny).
   - `skill_review` → before using a skill (supply-chain).
   - `persona_propose_edit` → propose a self-edit of the spec (governed by consensus).
3. **Close:** `persona_audit` (chain integrity + anomalies). **State and memory persist**; next
   session, `persona_state`/`persona_compiled` restore who it is.

**B3: agents.md/HTTP:** the same operations over `curl` (`personaxis serve`) for agents that do
not speak MCP.

### Why a powerful agent would use it
- **Persistent, portable identity** across sessions, projects, and machines (no re-explaining who it is).
- **Governed, auditable evolution**: it adapts to the user without drifting unsafely (a compliance/security moat).
- **Memory with provenance** + anti-poisoning defenses (Zombie Agents).
- **A model-agnostic security second opinion**: `scan_text`, `evaluate_command`, `skill_review`
  work the same regardless of the host's model.

### Multi-persona (overseer)
`personaxis orchestrate "<task>"` routes the task to the best-matched persona by capability
(blackboard). In B2, a host orchestrator can ask personaxis for the ranking and then delegate the
real work to that persona/subagent.

## 11. How to run it

```bash
pnpm install && pnpm run build && pnpm run test
node packages/cli/dist/index.js                 # live REPL (uses .personaxis/personaxis.md)
node packages/cli/dist/index.js sigil            # sigil + panel
node packages/cli/dist/index.js overseer show    # master view
node packages/cli/dist/index.js serve --persona .personaxis/personaxis.md   # HTTP + agents.md
node packages/tui/dist/index.js --persona .personaxis/personaxis.md         # dashboard
```

A local model for the *appraise* step (constrained decoding keeps a 4B-or-less model safe):

```bash
export PERSONAXIS_ENDPOINT=http://localhost:11434/v1   # Ollama / llama.cpp
export PERSONAXIS_MODEL=qwen3:4b
```
