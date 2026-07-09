/**
 * Shared fast-check arbitraries for the property suite (F6.1, MATH_CORE.md §8).
 *
 * The generators deliberately include hostile shapes: degenerate envelopes
 * (lo = mean = hi), huge and tiny deltas, values seeded outside the box —
 * shrinking turns any surviving counterexample into the smallest falsifier
 * (the falsifiability instrument for H1, RESEARCH.md §4).
 *
 * Run count: FC_NUM_RUNS env (CI cranks it up; local stays fast).
 */
import fc from "fast-check";
import type { Envelope } from "../../src/index.js";
import type { StateFile } from "../../src/index.js";

export const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 200);
/** File-system-heavy properties (chain): 1/10 of FC_NUM_RUNS, capped — or set
 *  FC_FS_NUM_RUNS explicitly. Each case does real fs writes. */
export const FS_NUM_RUNS = Number(
  process.env.FC_FS_NUM_RUNS ?? Math.min(Math.max(40, Math.ceil(NUM_RUNS / 10)), 1000),
);
/** Generous vitest timeout for fs-bound property tests (ms). */
export const FS_TIMEOUT = 600_000;
/** Timeout for CPU-bound properties — E3 runs them at FC_NUM_RUNS=100000. */
export const PROP_TIMEOUT = 600_000;

const bounded = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

/** An envelope with lo ≤ mean ≤ hi; ~10% degenerate (lo = mean = hi). */
export const envelopeArb: fc.Arbitrary<Envelope> = fc
  .tuple(bounded(-1000, 1000), bounded(-1000, 1000), bounded(-1000, 1000), fc.nat(9))
  .map(([a, b, c, degenerate]) => {
    if (degenerate === 0) return { mean: a, min: a, max: a };
    const [lo, mid, hi] = [a, b, c].sort((x, y) => x - y);
    return { mean: mid, min: lo, max: hi };
  });

/** A named set of 1..8 envelopes keyed like real state fields. */
export const envelopesArb: fc.Arbitrary<Record<string, Envelope>> = fc
  .array(envelopeArb, { minLength: 1, maxLength: 8 })
  .map((envs) =>
    Object.fromEntries(envs.map((e, i) => [`personality.traits.t${i}`, e])),
  );

/** Finite deltas across 9 orders of magnitude, signed. */
export const deltaArb = bounded(-1e9, 1e9);

export function freshState(): StateFile {
  return {
    schema_version: "1.0",
    persona_id: "prop-test",
    persona_version: "0.0.0",
    values: {},
    mutation_log: [],
  };
}

/** A mutation plan: sequences of (field-index, delta) over a given field list. */
export const planArb = (fieldCount: number) =>
  fc.array(fc.tuple(fc.nat(fieldCount - 1), deltaArb), { minLength: 1, maxLength: 60 });
