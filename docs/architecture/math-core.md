# The math core, as implemented

> Formal definitions/theorems: [`docs/MATH_CORE.md`](../MATH_CORE.md) (single source).
> This page maps them to code so a newcomer (human or AI) can navigate in one read.

## Modules (`packages/core/src/math/`)

| Module | Implements | Consumed by |
|---|---|---|
| `uspace.ts` | `toU/fromU` (Def. 4 — the meaning of every value), `projectValue/project` (Π_B), `rho` metric | drift, dash gauges, proof |
| `bands.ts` | `bandOf/bandCrossing/bandBoundaries` (Def. 6; declared `{low_max, moderate_max}` or defaults 0.33/0.66 · signed −0.33/+0.33), `bandRepresentatives`, `expressionFor` | compile stage-1, loop recompile trigger, jacobian |
| `drift.ts` | `driftReport` (per-coordinate u/band/headroom + **T3 live** `minStepsToCross`, ∞ for protected), `layerDrift` vs `governance.drift_thresholds` | `state drift`, `/drift`, dash, loop `drift` event |
| `homeostasis.ts` | `decayRate` (λ = 1−2^(−1/h)), `applyHomeostasis` (audited `runtime-decay`) — T6 | loop tick (pre-gate) |
| `arbitration.ts` | the total order (governance ≻ weight ≻ name), `arbitrate` with trace, `rankValues` — A1/A2 | `arbitrate`, `/arbitrate`, `.dist/` RUNTIME slice |
| `jacobian.ts` | `jacobianCompile` (σ exact via band representatives + line-edit distance), `staticallyDecorative` | `jacobian`, `decorative-number` lint |

## Where the theorems touch the engine

- **T1/T2** — `state-engine.ts applyMutation` (clamp + audit) behind
  `governance.ts governMutations` (cap, protected, mode). Loop: `loop.ts` tick.
- **T3 forensic** — `applyMutation` hash-chains every entry
  (`prev_hash`/`hash`, spec v1.1); `verifyMutationChain` tolerates a pre-1.1
  legacy prefix only.
- **T4** — `state-rebuild.ts` (state ≡ fold of the log).
- **T5** — `memory.ts` (chain over `content_hash` ⇒ real erasure keeps verifying).
- **T6** — `applyHomeostasis` runs inside the tick's lock BEFORE admitted deltas.
- **Recompile ≡ band crossing** — `loop.ts` (within-band movement is expression
  variance; the crossing rewrites the compiled doc via the stage-1 assembler with
  fresh `stateValues` — see `compile/assemble.ts sectionExpression`).

## The proof surface

- Properties: `packages/core/test/properties/` (PB-T1..T6, PB-A1/A2, PB-J, chain;
  `FC_NUM_RUNS` scales — CI 5000, E3 run 100000) + `packages/cli/test/genesis.test.ts`
  (PB-G: Genesis valid-by-construction against the real validator).
- Conformance: `packages/evals` (15 deterministic scenarios, C0/C1/C2).
- Experiments: `packages/evals/experiments/` (E3/E4 recorded; E1/E2/E5/E6 runners
  ready — see its README).
- Live demo: `personaxis proof`.
