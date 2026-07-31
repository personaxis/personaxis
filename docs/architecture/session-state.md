# Session state over a shared governed baseline (V4.4 design doc)

Status: DESIGN (approved path for implementation; the engine is single-instance today).
This is the seam the hosted deployment model needs: ONE persona, N concurrent sessions
(doc 10, saas item 8). The saas consumes it; the engine owns it.

## The problem

Today `state.json` is the persona's single mutable surface. Two concurrent sessions
(two REPLs, or the saas serving N end users through one persona) would fight over it:
one user's mood swing would leak into everyone else's conversation, and the mutation
log would interleave unrelated causal chains.

## The model

Split the mutable surface into two planes, both inside the SAME declared box:

1. **Shared governed baseline** (exists today): `state.json` + the spec's envelopes.
   Changes pass the governance gate as always. This is WHO the persona is, for everyone.
2. **Session overlay** (new): per-session ephemeral deviations,
   `sessions/<id>.state.json`, holding `overlay.values` as DELTAS from the baseline.

The effective value a session sees is:

```
effective(field, s) = clamp_envelope( baseline(field) + overlay_s(field) )
```

Clamping happens against the SAME envelope box, so **T1 (confinement) and T2 (bounded
steps) hold per session by construction**; a session can never take the persona outside
its declared self, no matter what its user does.

## Rules

- **Overlay writes** go through the same numeric gate (max_step_delta, protected
  fields) but require NO governance approval: they are lived experience, not identity
  change. They decay by the coordinate's `half_life` (homeostasis, T6) and DIE with the
  session (or are distilled into memory by the normal consolidation path).
- **Baseline writes** stay exactly as today: governance gate, mutation_log, hash chain.
  A session can only PROPOSE a baseline change (the suggesting flow); aggregation can
  batch-propose (e.g. "78% of sessions drifted warm, propose +0.05 tone mean").
- **Ledgers**: each overlay has its own hash-chained session ledger (same entry shape);
  the shared mutation_log records only baseline changes. Replay (T4) then holds on both
  planes independently: baseline replays from mutation_log, a session replays from its
  own ledger over the baseline snapshot it started from (recorded in the ledger head).
- **Drift**: per-session drift is computed on effective values (what that user actually
  experienced); baseline drift on baseline values. The saas aggregation pipeline samples
  per-session drift into the distribution the trust page shows (sessions served, drift
  distribution, clamps, blocked injections, zero hard-limit crossings).

## Engine changes (additive, no spec change)

- `core/src/persona.ts`: `readSessionOverlay(handle, sessionId)` /
  `writeSessionOverlay(...)`; `effectiveValues(handle, sessionId?)`.
- `core/src/governance.ts`: the numeric gate takes an optional `plane: "baseline" |
  "overlay"`; overlay skips the approval queue, keeps clamp + audit.
- `core/src/loop.ts`: the Living Loop takes `sessionId`; observe/appraise/evolve write
  the overlay; recompile stays baseline-only (the compiled document is shared).
- `sdk`: `persona.session(id)` returns a facade whose `observe/adjust/state` are
  session-scoped; `persona.state()` without a session stays baseline (compat).
- The REPL keeps using ONE implicit session (its session id), which makes today's
  behavior a special case: N=1.

## Why not fork the whole state per session?

Forking state.json per session would break the single-identity guarantee (each fork
could drift independently and "the persona" would stop meaning anything) and would
multiply governance surfaces. Deltas over one governed baseline keep identity singular,
bounded and auditable, which is the product's entire claim.

## Implementation order

1. Overlay read/write + effective values + tests (T1/T2 hold per session).
2. Loop + SDK session facade; REPL switches to explicit sessionId (behavior unchanged).
3. Aggregation sampler (per-session drift snapshots, append-only) for the saas.
