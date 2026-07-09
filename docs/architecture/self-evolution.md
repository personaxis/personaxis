# Self-evolution: how `personaxis.md` changes itself, and compiles to `PERSONA.md`

This is the "living" part of the spec. It answers: *as you converse (or a big agent uses
the persona), how does the spec adapt — what is allowed to change, how is it chosen, how is
it evaluated/audited, and how does that reach the compiled `PERSONA.md`?*

Source: `packages/core/src/{self-evolution.ts, loop.ts, governance.ts, appraisal.ts,
memory.ts}`; `packages/cli/src/commands/{compile,decompile,mode}.ts`.

## 1. The switch: `improvement_policy.mode`

One field decides whether the spec may evolve itself (`readMode`, `governance.ts`):

| mode | behavior |
|---|---|
| `locked` | the spec NEVER self-edits — humans only. |
| `suggesting` | the persona PROPOSES edits; they queue for approval. |
| `autonomous` | proposals auto-apply, still gated (consensus + protected paths). |

Change it from the CLI: `personaxis improve <mode>` or the REPL `/improve`. It is written
inline into the frontmatter (`improvement_policy.mode`), which is what the runtime reads.

## 2. What can change, and how it's chosen

A self-edit targets a **dot-path**, not "a whole layer". **Any spec section may be targeted**
except the protected safety floor — quantitative *and* qualitative, in any layer:

- **Quantitative** — envelope values/numbers, e.g. `personality.traits.openness.mean`,
  `affect.baseline.mood.tone`. These are clamped to the declared `mean ± range`.
- **Qualitative / any other layer** — `persona.voice_exemplars`,
  `cognition.uncertainty_policy.disclose_when_above`, `values_and_drives.values.curiosity.weight`,
  `metacognition.*`, … Whether a given section is editable is decided by `editGate` (§3b), which
  composes the protected floor + the author's declared per-layer policy + the global mode.

**Who proposes it.** The **Living Loop** (`loop.ts`): `observe → appraise → govern → mutate
→ memory`. An *appraiser* (heuristic or LLM, `appraisal.ts`) reads the observation and emits
a signal `{ field, delta, confidence, rationale }`. The **governance gate** admits or rejects
the signal based on `improvement_policy.mode` and per-layer edit policy.

## 3. How it's evaluated and audited (before anything is applied)

Defense in depth, all in `self-evolution.ts`:

1. **Protected paths** — `identity`, `character`, `values_and_drives.values.safety`,
   `self_regulation.hard_limits`, `persona.constraints`, `permissions`,
   `governance.max_step_delta`, … can NEVER be self-edited (rejected, not clamped).
2. **Provenance gate** — the justification must clear the `self_edit` sensitive-action gate
   (untrusted sources are refused).
3. **Consensus quorum** — a set of independent verifiers must pass (unanimous by default):
   - `invariant` (no protected path),
   - `envelope-sanity` (min<max, mean in range, bounded to [-1,1]),
   - `rationale` (non-empty justification),
   - `qualitative-safety` (NEW) — scans any prose for prohibited claims (real
     feelings/consciousness) or attempts to weaken safety (override/ignore limits,
     jailbreak/DAN) and **rejects** them.
4. **Append-only, hash-chained ledger** (`self-edits.jsonl`): `propose → approve → apply →
   revert`. Each `apply` mints a `PersonaVersion` and is **reversible**.
5. **Overlay, not rewrite** — applied edits live in an *overlay* (dot-path → value) mounted
   onto the frontmatter at load time. The commented spec file is never machine-rewritten.

> State note: self-edits go to the **ledger**, not `state.json`. `state.json` holds
> operational runtime dials (mood/affect), which the state engine clamps + logs separately.

## 3b. Whole-spec self-edits in the Living Loop (live) — `editGate`

The loop no longer evolves only numbers, and qualitative edits are **no longer limited to
`persona`**. Each turn the appraiser may emit `selfEdits[]` targeting any editable
section alongside its numeric signal (`loop.ts` step 3b; `appraisal.ts` / `llm-appraiser.ts`).
The loop offers the appraiser the list of editable sections via `editableLayers(frontmatter, mode)`.
Each proposed edit is resolved by **`editGate(targetPath, frontmatter, mode)`** → `block | queue | auto`,
which composes three layers:

1. **Protected floor** (`PROTECTED_PREFIXES`) — `identity`, `character`, `hard_limits`, `safety`,
   `affect.regulation_policy`, `memory.deletion_policy`, `governance.max_step_delta`,
   `governance.per_layer_edit_policy`, `permissions`, … → **always `block`**, every mode.
2. **The author's declared per-layer policy** — `governance.per_layer_edit_policy.<topLayer>` (spec
   enum `human_approval_required`/`review_required`/`auto_approved`/`governance_controlled`, plus the
   runtime synonyms `locked`/`open`): `locked`/`human_only` → `block`;
   `human_approval_required`/`review_required` → **always `queue`** (forced review, even when the
   global mode is `autonomous`); `auto_approved` → **`auto`** (overrides a global `suggesting`; the
   `locked` master switch still wins); `governance_controlled`/`open` → follow the mode.
3. **The global mode** (`improvement_policy.mode`) for any layer the author left to follow it.

The numeric envelope path is unchanged — it still goes through the state engine's clamp + drift
guard (`governance.max_step_delta`), and for numbers `suggesting` and `autonomous` behave the same
(mutations are cheap, clamped, reversible). The mode-level difference lives in the qualitative path:

| mode | qualitative behavior (for a `governance_controlled`/`open` layer) |
|---|---|
| `locked` | proposes nothing. |
| `suggesting` | enqueues `pending` in `self-edits.jsonl`; NEVER auto-applies. |
| `autonomous` | auto-applies, still gated (see below). |

Even when `editGate` returns `auto`, the apply must clear **all** of: the unanimous consensus
verifiers (§3), the `PROTECTED_PREFIXES` floor, and the `sensitiveActionGate("self_edit")`
provenance gate, which requires a `user`-trust justification (trust level 3). Consequently an
**internal tick can never auto-edit** — only an edit justified by the user clears the gate.

> `governQualitative(mode)` still exists (mode→action, used by tests) but the loop now uses
> `editGate`, so the **author's per-layer policy** can override the mode (e.g. force review on a
> sensitive layer while the rest of the spec follows `autonomous`).

Hardening:

- A malicious **injection** in the observation blocks **every** self-edit that turn
  (defense in depth), independent of mode.
- Self-edits do **not** count as `mutationsApplied` — that metric (and the injection eval)
  stays about numbers only.
- On apply, the loop writes `.recompile-pending.json`; the REPL then recompiles `PERSONA.md`
  so the applied overlay (including qualitative edits) reaches the compiled doc.

## 3c. Reviewing the queue (`/review`)

Under `suggesting`, proposals sit in `self-edits.jsonl` as `pending`. In the REPL,
`/review` lists them and `approve`/`reject <id|all>` resolves them — an `approve` mints the
`PersonaVersion` and applies the overlay; a `reject` closes the entry. Nothing in
`suggesting` mode reaches the compiled doc until you approve it.

## 4. From spec to `PERSONA.md` (compile)

`personaxis compile` takes `personaxis.md` (including the `persona` block) and asks
the configured provider to assemble the **persona-prompting** `PERSONA.md` — second-person
role adoption, character card, voice exemplars, scene contracts, guardrails (see
[compile.md](./compile.md) and the methodology in `persona.md/docs/PERSONA_PROMPTING.md`).
`state.json` is reference-only; the compile is driven by the spec.

## 5. Recompile triggers

- **Numeric path: band crossing, and only band crossing (Implemented, v1.1 — the normative
  trigger, SPEC §15).** Envelope movement *within* a behavior band is expression variance and
  does NOT recompile. When a governed tick makes a coordinate **cross a band**, the loop
  emits a `drift` event and rewrites the compiled doc via the deterministic stage-1 assembler
  with fresh `stateValues` (the crossing selects new per-band `expression` prose — no LLM in
  this path). See `loop.ts` + `compile/assemble.ts sectionExpression`;
  [math-core.md](./math-core.md) maps it to the theorems.
- **Stale-marking, not inline recompile (Implemented).** A full LLM recompile on every turn was
  the "stuck thinking" hang, so the loop no longer blocks the turn to recompile. When a self-edit
  is applied it writes `.recompile-pending.json`; the REPL surfaces `· PERSONA.md stale (self-edits
  applied) — /compile to refresh`. Recompile happens explicitly on `/compile`, on `/review approve`,
  or on exit. (The fast `.live.json` numeric marker is written every turn but does **not** rewrite
  the compiled prose.)
- **Overlay-aware compile (Implemented).** `compile` now folds the **active overlay** (applied
  governed self-edits) into the prompt as authoritative overrides (`activeOverlay`), so a
  recompile reflects what the persona evolved into — including *qualitative*
  `persona` edits — without machine-rewriting the commented spec.

### Honest gaps (Planned)

- **Auto-recompile after a ledger apply outside the loop** (e.g. an MCP `persona_propose_edit`
  applied in `autonomous` mode) is not auto-triggered: it records the edit; you then run
  `personaxis compile` (which now folds the overlay). Wiring a provider-backed recompile into
  the MCP apply path is tracked.

## Verify it yourself

```bash
personaxis improve suggesting            # set the mode (writes improvement_policy.mode)
# in the REPL: just chat                 # the Living Loop runs one governed cycle every turn
# in the REPL: /review                   # see/approve queued self-edits; /state shows the overlay
# MCP: persona_propose_edit              # propose a quantitative OR qualitative edit
```
Tests: `packages/core/test/self-evolution.test.ts` (protected paths, consensus, revert) and
`qualitative-evolution.test.ts` (`editGate` composition; a self-edit to a non-`persona`
layer is applied under `autonomous`).
