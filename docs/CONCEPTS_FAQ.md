# Concepts FAQ — your 18 questions, answered directly

A single, navigable answer to the conceptual questions about how this CLI behaves, each
linking to the deeper architecture doc. If a question's answer ever stops matching the code,
**the code is the source of truth** — file an issue, because a doc drifted.

Jump to: [Compile/decompile](#1-compiledecompile) · [Sub-personas](#2-sub-personas--routing) ·
[Self-evolution](#3-self-evolution-what-evolves-and-who-decides) · [Sigil](#4-the-sigil) ·
[Modes](#5-the-three-improvement-modes) · [Memory](#6-memory-six-kinds-creation-and-recall) ·
[Sessions](#7-sessions-resume-compact) · [Sandbox](#8-sandbox--permissions) ·
[Awareness](#9-structural-awareness) · [Reply format](#10-reply-format) ·
[Per-turn observability](#11-what-the-per-turn-summary-shows) · [Commands](#12-every-repl-command-and-why-it-exists)

---

## 1. Compile / decompile

**Q: What is compile vs decompile, who triggers it, and when?**

There are three artifacts (see [docs/README.md](README.md#the-three-artifact-model-start-here)):
`personaxis.md` (the spec — quantitative + persona-prompting), `PERSONA.md` (the compiled,
LLM-facing prose — system-prompt slot #1), and `state.json` (numeric runtime dials).

- **compile** (`personaxis compile [--root]`): `personaxis.md` → `PERSONA.md`. An LLM, via the
  configured provider, turns the spec into a second-person character-card + scene-contract document.
  It is **purely qualitative** — no numeric state is baked into it (that lives in `state.json` +
  `.live.json`). Triggered: explicitly by you (`personaxis compile`), by `/compile` in the REPL,
  or by `/review approve` after a self-edit marks the doc stale.
- **decompile** (`personaxis decompile [--root]`): `PERSONA.md` → a *proposed* `personaxis.md`,
  re-validated against the schema. This folds hand-edits to the prose back into the spec. The
  provider code-fence is stripped (the compiled doc is prose, not a fenced block).

Detail: [architecture/compile.md](architecture/compile.md). Per-command: [commands/compile.md](commands/compile.md),
[commands/decompile.md](commands/decompile.md).

**Why isn't the numeric state in PERSONA.md anymore?** It used to inject a `LIVE-STATE` block,
which was redundant with `state.json`. The compiled doc is now stable prose; drift is tracked in
`.live.json` (a fast marker), and a self-edit that changes the spec marks `PERSONA.md` stale rather
than rewriting it on every turn (that was the "stuck thinking" hang). Recompile is explicit (`/compile`).

---

## 2. Sub-personas + @routing

**Q: How do sub-personas work, and how does `@slug` routing work?**

A sub-persona compiles to `.personaxis/personas/<slug>/PERSONA.md` (inside its own folder, with its
own resources). The layout **recurses** — a sub can have its own subs. In the REPL:

- `@slug your message` routes one turn to that sub-persona; `@parent/child` addresses a nested sub;
  `@all` broadcasts. Routing is **read-only across personas**: a sub cannot write another persona's
  files (enforced by `crossPersonaDenies`); the root can *read* a child's memory but not write it.
- A delegation is recorded in **both** sessions (root's and the sub's).

Detail: [architecture/multi-persona.md](architecture/multi-persona.md).

---

## 3. Self-evolution: what evolves, and who decides?

**Q: Is only the numeric state mutable? I wanted the whole spec mutable, but safely controlled.**

Resolved. **Any spec section is now self-editable** — quantitative envelopes, qualitative
persona-prompting prose, *and* any other layer (`cognition`, `values_and_drives`, `metacognition`, …) —
**except the protected safety floor, which can never change**. Editability is decided by `editGate`,
which composes three layers:

1. **The safety floor** (`PROTECTED_PREFIXES`) — `identity`, `character`, `reflexive_self_regulation.hard_limits`,
   the `safety` value + `safety_over_completion`, `affect.regulation_policy`, `memory.deletion_policy`,
   `governance.max_step_delta`, `governance.per_layer_edit_policy`, `permissions`. **Always blocked**,
   in every mode. This is the universal-invariant set the validator enforces.
2. **The author's declared per-layer policy** — `governance.per_layer_edit_policy.<layer>` (the spec
   enum: `human_approval_required` / `review_required` / `auto_approved` / `governance_controlled`;
   the runtime also accepts `locked`/`open` synonyms). Mapping: `locked`/`human_only` → block;
   `human_approval_required`/`review_required` → always queue for `/review`, even in autonomous;
   `auto_approved` → auto-apply (overrides a global `suggesting`, but `locked` mode still wins);
   `governance_controlled`/`open` → follow the mode. This is the "variable que indica qué secciones
   pueden editarse" you asked for — explicit, per-layer, auditable.
3. **The global mode** (`improvement_policy.mode`) — see [§5](#5-the-three-improvement-modes).

The result is `block | queue | auto`. Two more gates always apply: a **malicious-injection** scan
blocks *all* self-edits that turn, and the **provenance gate** requires a `user`-trust justification
(an internal/tool tick cannot self-edit). Applied edits live in an **append-only `self-edits.jsonl`
ledger** and take effect via an *overlay* (the spec file is versioned, not silently overwritten).

The numeric envelope path is unchanged (clamp + `max_step_delta`); modes differentiate the
*qualitative* path. Detail: [architecture/self-evolution.md](architecture/self-evolution.md).

---

## 4. The sigil

**Q: What is the sigil and what does it mean?**

A deterministic per-persona glyph + color, derived by hashing the persona's identity (`sigil.ts`).
It is a stable visual fingerprint: the same persona always renders the same sigil, and it prefixes
that persona's replies so you can tell root from sub at a glance. It carries no governance meaning —
it's an identity marker, shown in `/persona`.

---

## 5. The three improvement modes

**Q: `locked` / `suggesting` / `autonomous` — were they actually different?**

For qualitative self-edits, yes (this is where the real difference lives):

| Mode | Qualitative self-edit | Numeric envelope nudge |
|---|---|---|
| `locked` | Proposes nothing | Blocked |
| `suggesting` (recommended interactive default) | **Queued** in the ledger as `pending` → review in batch with `/review`; never interrupts chat | Applied (clamped + governed) |
| `autonomous` | **Auto-applied** (still gated by consensus verifiers + protected paths + provenance) | Applied (clamped + governed) |

Numeric nudges are cheap, clamped, reversible and bounded by `max_step_delta`, so `suggesting` and
`autonomous` treat them the same — changing that would break the `max-step-delta` guarantee. Set the
mode with `/improve <mode>` or `personaxis improve <mode>`. Detail: [commands/improve.md](commands/improve.md),
[commands/review.md](commands/review.md).

---

## 6. Memory: six kinds, creation, and recall

**Q: Is a memory created every message? Are the six `memory.types` actually honored? Which evaluations?**

All six `memory.types` are real and **each producer honors its flag** (turning a type off in the spec
means nothing is written for it):

- **episodic** (`memory/episodic.jsonl`) — hash-chained, tamper-evident; written when the appraiser
  proposes a note (not blindly every message).
- **semantic** (`memory.md`) — consolidated from episodic.
- **procedural** (`memory/procedural.jsonl`) — a successful agent run becomes a reusable "how-to".
- **autobiographical** (`memory/autobiographical.jsonl`) — identity milestones (e.g. a mode change).
- **user_preferences** (`memory/preferences.json`, last-wins) — stable preferences the appraiser infers.
- **evaluations** (`memory/evaluations.jsonl`) — deterministic quality/utility scoring of what was
  written each turn: `{ target, dimension: safety|usefulness|accuracy, score 0..1, rationale }`.
  `safety=0` for injection-flagged content; `usefulness` rewards substantive, user/synthesis-sourced notes.

**Creation and recall are both visible per turn** (your complaint about "+1 eval(s)"):
- *created* → `memory +1 episodic ([user] the user prefers terse…)`
- *recalled* (memory used to answer) → `recalled episodic×2 (…)`
- *evaluated* → `evaluated #a1b2c3d4 usefulness 0.74 · turn safety 1.00`

Inspect all six with `/memory`; scores + the self-edit ledger with `/audit`. Detail:
[architecture/memory.md](architecture/memory.md), [§11](#11-what-the-per-turn-summary-shows).

---

## 7. Sessions, resume, compact

**Q: Are conversations persisted? `/resume`? `/compact`?**

Yes. Each persona has `.personaxis/[personas/<slug>/]sessions/<id>.jsonl` (a header + one row per turn).

- `/sessions` lists named sessions (auto-named by the model from the first message, or a timestamp
  fallback) with date + turn count.
- `/resume <id|name>` rehydrates the conversation into context (compacting first if the context meter is high).
- `/compact` summarizes older turns in the *current* session to free context (it does **not** persist a
  new session — it's a within-session operation).

Detail: [architecture/sessions.md](architecture/sessions.md), [commands/sessions.md](commands/sessions.md).

---

## 8. Sandbox / permissions

**Q: Does the sandbox (shift+tab posture) actually change anything?**

Yes — but with an honest limit. It is a **two-axis policy gate** (sandbox posture × approval mode);
`deny` takes highest precedence, and the gate runs *before* any tool exec / file write. Cycling the
posture (shift+tab) rebuilds the policy each turn, so a destructive command is `deny`/`ask`/`allow`
depending on the posture. You may not have noticed a difference if you only ran read-only commands —
those pass in all postures.

**Honest limitation:** on Windows there is **no OS-level sandbox**. Containment is by the policy gate
(deny-list classification + workspace-escape detection), not kernel isolation. Detail:
[architecture/sandbox.md](architecture/sandbox.md).

---

## 9. Structural awareness

**Q: Does the agent know whether it is root or a sub, and what's around it?**

Yes — injected into the system prompt as a `# Structure & resources` block (`buildAwarenessBlock`): its
role (root vs `sub-persona @address`), its address, its own sub-tree, and the resource inventory beside
its spec (`memory.md`, `references/`, `examples/`, `skills/`, …). Detail:
[architecture/awareness.md](architecture/awareness.md). Inspect the same with `/persona`.

---

## 10. Reply format

**Q: The `Clio:` / `Clio>` reply prefix.**

Replies render as `<sigil> <bold underlined name> ›  <text>`. The root uses its default foreground;
each sub-persona gets its own color, so a delegated reply is visually distinct. The sigil glyph is the
microdetail at the head of the line.

---

## 11. What the per-turn summary shows

After each reply, a single dim line summarizes what actually happened that turn — only the parts that
occurred appear:

```
· recalled episodic×2 (the user prefers terse…)  ·  evolved mood.tone 0.00→0.10  ·
  self-edit applied: cognition.uncertainty_policy.disclose_when_above  ·
  memory +1 episodic ([user] …)  ·  evaluated #a1b2c3d4 usefulness 0.74 · turn safety 1.00
· PERSONA.md stale (self-edits applied) — /compile to refresh
```

This is real observability: memory **used**, state **evolved**, self-edits **proposed/applied**,
memory **created**, and **evaluations with their target + dimension + score** — never an opaque counter.

---

## 12. Every REPL command, and why it exists

| Command | Purpose |
|---|---|
| `/help` | List commands. |
| `/persona` | Identity, role (root/sub), sub-tree, resource inventory, mode, sandbox posture, sigil (absorbs the old `/sigil`). |
| `/state` | The **whole mutable surface**: envelope values (quantitative) + applied self-edits (qualitative overlay) + pending proposals — not just the 9 numbers. |
| `/improve [mode]` | View/set `locked \| suggesting \| autonomous` ([§5](#5-the-three-improvement-modes)). |
| `/review [approve\|reject] <id\|all>` | The governance queue: list/approve/reject queued self-edits; approving recompiles. |
| `/compile` | Explicitly recompile `PERSONA.md` from the evolved spec (only when marked stale). |
| `/audit` | Mutation log + memory-chain integrity + self-edit ledger + recent evaluations. |
| `/memory` | All six memory kinds with recent entries (shows `(off)` for a disabled type). |
| `/sessions`, `/resume` | List / rehydrate persistent conversations ([§7](#7-sessions-resume-compact)). |
| `/compact` | Summarize older turns to free context (within the current session). |
| `/goal` | View/set the standing goal injected into the agent. |
| `/loop` | Run the autonomous goal loop. |
| `/model` | Show the model in use. |
| `/mode` | Cycle the sandbox posture (also shift+tab). |
| `/overseer` | Optional cross-machine/project registry view (complements git; empty until populated). |
| `/exit` | Leave the session. |

Removed: `/do` (was identical to just chatting) and `/evolve` (duplicated the per-turn tick); `/sigil`
folded into `/persona`. Per-command detail: [commands/README.md](commands/README.md).
