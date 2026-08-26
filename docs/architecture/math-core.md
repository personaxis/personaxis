# The math core, as implemented

> Formal definitions/theorems: the formal core `MATH_CORE.md` (in the research bundle, forthcoming public report).
> This page maps them to code so a newcomer (human or AI) can navigate in one read.

## Modules (`packages/core/src/math/`)

| Module | Implements | Consumed by |
|---|---|---|
| `uspace.ts` | `toU/fromU` (Def. 4, the meaning of every value), `projectValue/project` (Π_B), `rho` metric | drift, dash gauges, proof |
| `bands.ts` | `bandOf/bandCrossing/bandBoundaries` (Def. 6; declared `{low_max, moderate_max}` or defaults 0.33/0.66 · signed −0.33/+0.33), `bandRepresentatives`, `expressionFor` | compile stage-1, loop recompile trigger, jacobian |
| `drift.ts` | `driftReport` (per-coordinate u/band/headroom + **T3 live** `minStepsToCross`, ∞ for protected, `decayAssisted` for recovery exits on `half_life` coordinates), `layerDrift` vs `governance.drift_thresholds` | `state drift`, `/drift`, dash, loop `drift` event |
| `homeostasis.ts` | `decayRate` (λ = 1−2^(−1/h)), `homeostaticMoves` (pure: values in, moves out; written to the record as `runtime-decay`), T6 | loop tick (pre-gate) |
| `arbitration.ts` | the total order (governance ≻ weight ≻ name), `arbitrate` with trace, `rankValues`, A1/A2 | `arbitrate`, `/arbitrate`, `.dist/` RUNTIME slice |
| `jacobian.ts` | `jacobianCompile` (σ exact via band representatives + line-edit distance), `staticallyDecorative` | `jacobian`, `decorative-number` lint |

## Where the theorems touch the engine

- **T1/T2**: `record/mutate.ts decide` (clamp) and `mutate` (clamp + write the
  entry) behind `governance.ts governMutations` (cap, protected, mode). One move
  end to end is `record/adjust.ts adjust`; a batch that must land together is
  `adjustAll`. Loop: `loop.ts` tick.
- **T3 forensic**: `record/chain.ts` hash-chains every entry, with the sequence
  number and the author INSIDE the hash, so an edit, a reorder, an insertion or a
  deletion breaks verification from that point on. `verify` checks a whole chain;
  `holds` checks one entry on its own.
- **T4**: `record/derive.ts derive` (state ≡ fold of the record). The state file
  is printed from that fold by `record/project.ts`, so it is a view and not a
  second source; `personaxis state rebuild` compares the two.
- **T5**: `memory.ts` (chain over `content_hash` ⇒ real erasure keeps verifying).
- **T6**: `homeostaticMoves` runs inside the tick's lock BEFORE admitted deltas,
  as part of the same batch, so a tick is one transaction and not a sequence of
  them.
- **Recompile ≡ band crossing**: `loop.ts` (within-band movement is expression
  variance; the crossing rewrites the compiled doc via the stage-1 assembler with
  fresh `stateValues`, see `compile/assemble.ts sectionExpression`).

## The proof surface

- Properties: `packages/core/test/properties/` (PB-T1..T6, PB-A1/A2, PB-J, chain;
  `FC_NUM_RUNS` scales, CI 5000, E3 run 100000) + `packages/cli/test/genesis.test.ts`
  (PB-G: Genesis valid-by-construction against the real validator).
- Conformance: `packages/evals` (15 deterministic scenarios, C0/C1/C2).
- Experiments: the research bundle (E3/E4 recorded; E1/E2/E5/E6 runners
  ready, see its README).
- Live demo: `personaxis proof`.
