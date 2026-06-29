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

A self-edit targets a **dot-path**, not "a whole layer":

- **Quantitative** — envelope values/numbers, e.g. `personality.traits.openness.mean`,
  `affect.baseline.mood.tone`. These are clamped to the declared `mean ± range`.
- **Qualitative (v0.10)** — because `persona_prompting` fields are structured, prose evolves
  through the same path: `persona_prompting.voice_exemplars`,
  `persona_prompting.scene_contracts`, `…break_character_guardrails`, etc.

**Who proposes it.** The **Living Loop** (`loop.ts`): `observe → appraise → govern → mutate
→ memory`. An *appraiser* (heuristic or LLM, `appraisal.ts`) reads the observation and emits
a signal `{ field, delta, confidence, rationale }`. The **governance gate** admits or rejects
the signal based on `improvement_policy.mode` and per-layer edit policy.

## 3. How it's evaluated and audited (before anything is applied)

Defense in depth, all in `self-evolution.ts`:

1. **Protected paths** — `identity`, `character`, `values_and_drives.values.safety`,
   `reflexive_self_regulation.hard_limits`, `persona.constraints`, `permissions`,
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

## 3b. Qualitative self-edits in the Living Loop (live)

The loop no longer evolves only numbers. Each turn the appraiser may emit qualitative
`selfEdits[]` targeting the `persona_prompting` block alongside its numeric signal
(`loop.ts` step 3b; `appraisal.ts` / `llm-appraiser.ts`). These run through a **separate
governance layer** from the numeric envelope `judge`:

- **Numeric** envelopes go through the state engine's clamp + drift guard
  (`governance.max_step_delta`). For numbers, `suggesting` and `autonomous` behave the
  same — mutations are cheap, clamped, and reversible.
- **Qualitative** prose goes through `governQualitative(mode)` (`governance.ts`), which maps
  the mode to `block | queue | auto`. This layer **does not** touch the numeric drift guard.
  Here the modes genuinely differ:

| mode | `governQualitative` | qualitative behavior |
|---|---|---|
| `locked` | `block` | proposes nothing. |
| `suggesting` | `queue` | enqueues `pending` in `self-edits.jsonl`; NEVER auto-applies. |
| `autonomous` | `auto` | auto-applies, still gated (see below). |

Even under `autonomous`, an auto-apply must clear **all** of: the unanimous consensus
verifiers (§3), the `PROTECTED_PREFIXES` list (`identity`/`character`/`hard_limits`/`safety`
are never editable), and the `sensitiveActionGate("self_edit")` provenance gate, which
requires a `user`-trust justification (trust level 3). Consequently an **internal tick can
never auto-edit** — only an edit justified by the user clears the gate.

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

`personaxis compile` takes `personaxis.md` (including the `persona_prompting` block) and asks
the configured provider to assemble the **persona-prompting** `PERSONA.md` — second-person
role adoption, character card, voice exemplars, scene contracts, guardrails (see
[compile.md](./compile.md) and the methodology in `persona.md/docs/PERSONA_PROMPTING.md`).
`state.json` is reference-only; the compile is driven by the spec.

## 5. Recompile triggers

- **Quantitative drift → auto-recompile (Implemented).** When the Living Loop applies one or
  more envelope mutations, it fires a `recompile` event and calls the recompile hook
  (`loop.ts` step 4), so `PERSONA.md` reflects the new state. The REPL surfaces this as
  `· PERSONA.md recompiled` in the per-turn summary.
- **Overlay-aware compile (Implemented).** `compile` now folds the **active overlay** (applied
  governed self-edits) into the prompt as authoritative overrides (`activeOverlay`), so a
  recompile reflects what the persona evolved into — including *qualitative*
  `persona_prompting` edits — without machine-rewriting the commented spec.

### Honest gaps (Planned)

- **Auto-recompile after a ledger apply outside the loop** (e.g. an MCP `persona_propose_edit`
  applied in `autonomous` mode) is not auto-triggered: it records the edit; you then run
  `personaxis compile` (which now folds the overlay). Wiring a provider-backed recompile into
  the MCP apply path is tracked.

## Verify it yourself

```bash
personaxis improve suggesting            # set the mode (writes improvement_policy.mode)
# in the REPL: /evolve <observation>     # runs one governed Living-Loop cycle (shows the steps)
# MCP: persona_propose_edit              # propose a quantitative OR qualitative edit
```
Tests: `packages/core/test/self-evolution.test.ts` (protected paths, consensus, qualitative
edits, revert).
