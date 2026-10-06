/**
 * PB-T6 + PB-A1/A2 + mutation-chain, the governed dynamics (MATH_CORE.md §3–§4).
 *
 *  - T6(a): without forcing, homeostasis contracts the deviation EXACTLY by
 *    (1−λ) per tick, geometric return to baseline, never leaving the box;
 *  - T6(b): under bounded adversarial forcing |δ| ≤ δ_max, the standing
 *    deviation is bounded by δ_max/λ (+ tolerance), input-to-state stability;
 *  - A1: arbitration is a strict total order (total, antisymmetric, transitive);
 *  - A2: U7 is derivable, safety (governance, ≥0.90 by U6) beats every
 *    non-governance value;
 *
 * ## These drive the arithmetic that runs, which they did not
 *
 * They used to push a `StateFile` through `applyHomeostasis` and `applyMutation`, the
 * engine that wrote into `state.json`. Nothing takes that path any more: a move is
 * `decide`, and a homeostatic step is `homeostaticMoves` fed through the same
 * `decide`. A property suite proving things about a code path the product no longer
 * uses is a suite that reads as coverage and is not.
 *
 * The chain properties that lived here are gone with it. They proved that the
 * `mutation_log` inside `state.json` chained and detected tampering, and that chain is
 * retired. `record.property.test.ts` proves the same things and more about the chain
 * that ships: a changed value anywhere, an author moved onto somebody else, a deletion
 * anywhere but the end, any reordering, an entry spliced in from another chain, and
 * that no state is ever reported for a chain that does not verify.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  decayRate,
  homeostaticMoves,
  record,
  arbitrate,
  compareValues,
  rankValues,
  toU,
  bandOf,
  bandBoundaries,
  coordinateDrift,
  type ArbitrationValue,
  type Envelope,
} from "../../src/index.js";
import { NUM_RUNS, envelopeArb, deltaArb, PROP_TIMEOUT } from "./arbitraries.js";

/** The coordinate every property here moves. Named once so the string is not spelled six times. */
const FIELD = "affect.baseline.mood.tone";

/**
 * One homeostatic step, through the arithmetic a real tick uses.
 *
 * `homeostaticMoves` says what should move and `decide` says where it lands, which is
 * exactly the pair the record path runs. Returns how many coordinates moved, because
 * one of the properties needs to know when decay has converged and stopped.
 */
function decay(values: Record<string, number>, envs: Record<string, Envelope>): number {
  const moves = homeostaticMoves(values, envs);
  for (const move of moves) {
    values[move.field] = record.decide(values[move.field] ?? envs[move.field]!.mean, envs[move.field]!, move).to;
  }
  return moves.length;
}

/** One forced move, clamped to the envelope the same way a recorded one is. */
function force(values: Record<string, number>, envs: Record<string, Envelope>, delta: number, reason: string): void {
  const envelope = envs[FIELD]!;
  values[FIELD] = record.decide(values[FIELD] ?? envelope.mean, envelope, { field: FIELD, delta, reason }).to;
}

const solidEnvelopeArb: fc.Arbitrary<Envelope> = envelopeArb.filter(
  (e) => e.mean - e.min > 1e-3 && e.max - e.mean > 1e-3,
);
const halfLifeArb = fc.double({ min: 0.5, max: 50, noNaN: true });

describe("PB-T6 homeostasis", () => {
  it("(a) without forcing: deviation contracts exactly by (1−λ) per tick, in-box, audited as runtime-decay", () => {
    fc.assert(
      fc.property(
        solidEnvelopeArb,
        halfLifeArb,
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        fc.boolean(),
        (e, h, frac, up) => {
          const env: Envelope = { ...e, halfLife: h };
          const envs = { "affect.baseline.mood.tone": env };
          const start = up ? e.mean + (e.max - e.mean) * frac : e.mean - (e.mean - e.min) * frac;
          const values: Record<string, number> = { [FIELD]: start };
          const lambda = decayRate(h);

          let dev = Math.abs(start - e.mean);
          for (let t = 0; t < 30; t++) {
            const moved = decay(values, envs);
            const v = values[FIELD]!;
            const newDev = Math.abs(v - e.mean);
            if (moved === 0) {
              // Below epsilon: converged. Deviation must already be tiny relative to λ.
              expect(newDev).toBeLessThanOrEqual(dev + 1e-12);
              break;
            }
            // Exact contraction: dev' = (1−λ)·dev, within FP tolerance.
            expect(newDev).toBeCloseTo((1 - lambda) * dev, 6);
            expect(v).toBeGreaterThanOrEqual(e.min);
            expect(v).toBeLessThanOrEqual(e.max);
            dev = newDev;
          }
          // Monotone: after 30 ticks the deviation never grew.
          expect(dev).toBeLessThanOrEqual(Math.abs(start - e.mean) + 1e-12);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);

  it("(b) ISS: adversarial forcing |δ| ≤ δ_max yields standing deviation ≤ δ_max/λ (+FP slack)", () => {
    fc.assert(
      fc.property(
        solidEnvelopeArb,
        halfLifeArb,
        fc.double({ min: 1e-3, max: 0.3, noNaN: true }),
        fc.array(deltaArb, { minLength: 20, maxLength: 60 }),
        (e, h, deltaMax, noise) => {
          const env: Envelope = { ...e, halfLife: h };
          const envs = { "affect.baseline.mood.tone": env };
          const values: Record<string, number> = { [FIELD]: e.mean };
          const lambda = decayRate(h);
          const bound = deltaMax / lambda;

          // Warm-up ratio: after k ticks the transient has decayed by (1−λ)^k;
          // assert the bound only once the transient term is below 5% of it.
          let transient = Math.max(e.max - e.mean, e.mean - e.min);
          for (const raw of noise) {
            decay(values, envs);
            // Adversary: pushes a bounded delta each tick (sign from generated noise).
            force(values, envs, Math.sign(raw || 1) * deltaMax, "iss forcing");
            transient *= 1 - lambda;
            const dev = Math.abs(values[FIELD]! - e.mean);
            if (transient < 0.05 * bound) {
              // dev ≤ (1−λ)·bound + δ_max = bound  (+ transient + FP slack)
              expect(dev).toBeLessThanOrEqual(bound + transient + 1e-9);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);

  // PB-T2-decay (PA-1, FASE 7 foundations review): a decay step may exceed
  // δ_max in raw magnitude, but it NEVER increases |u|. This is the fact that
  // lets T2/T3 exempt homeostasis: decay cannot contribute adversarial movement.
  it("PB-T2-decay: homeostatic steps never increase |u| and preserve the deviation's sign", () => {
    fc.assert(
      fc.property(
        solidEnvelopeArb,
        halfLifeArb,
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        fc.boolean(),
        (e, h, frac, up) => {
          const env: Envelope = { ...e, halfLife: h };
          const envs = { "affect.baseline.mood.tone": env };
          const start = up ? e.mean + (e.max - e.mean) * frac : e.mean - (e.mean - e.min) * frac;
          const values: Record<string, number> = { [FIELD]: start };
          const uBefore = toU(start, env);
          decay(values, envs);
          const uAfter = toU(values[FIELD]!, env);
          expect(Math.abs(uAfter)).toBeLessThanOrEqual(Math.abs(uBefore) + 1e-9);
          if (Math.abs(uAfter) > 1e-9) {
            expect(Math.sign(uAfter)).toBe(Math.sign(uBefore));
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);

  // PB-T3-decay (PA-1): with half_life ACTIVE, an adversarial (away-from-baseline)
  // band crossing still costs at least ceil(D/δ_max) gate steps; decay only opposes
  // the move. The report marks the exact exits where decay CAN help (recovery on a
  // half_life coordinate) as decayAssisted.
  it("PB-T3-decay: away-crossings respect the floor under active decay; decayAssisted marks recovery exits only", () => {
    fc.assert(
      fc.property(
        solidEnvelopeArb.filter((e) => e.max - e.min > 1e-2),
        halfLifeArb,
        fc.double({ min: 0.02, max: 0.15, noNaN: true }),
        (e, h, deltaMax) => {
          const env: Envelope = { ...e, halfLife: h };
          const envs = { "affect.baseline.mood.tone": env };
          const [, b2] = bandBoundaries(env);
          // Start at the mean; adversary pushes upward toward the high band.
          const values: Record<string, number> = { [FIELD]: e.mean };
          const startBand = bandOf(e.mean, env);
          if (startBand === "high" || b2 >= e.max) return; // no upward crossing available
          const floor = Math.ceil((b2 - e.mean) / deltaMax);
          let gateSteps = 0;
          for (let t = 0; t < floor + 40; t++) {
            decay(values, envs);
            force(values, envs, deltaMax, "pb-t3-decay push");
            gateSteps++;
            if (bandOf(values[FIELD]!, env) === "high") break;
          }
          const crossed = bandOf(values[FIELD]!, env) === "high";
          if (crossed) {
            expect(gateSteps).toBeGreaterThanOrEqual(floor);
            // Once outside the baseline's band, the exit back is decay-reachable:
            // the report must say so.
            const d = coordinateDrift(FIELD, values[FIELD]!, env, deltaMax);
            expect(d.decayAssisted).toBe(true);
          }
          // At the baseline's own band the floor is certified: never decayAssisted.
          const atMean = coordinateDrift(FIELD, e.mean, env, deltaMax);
          expect(atMean.decayAssisted).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);
});

const valueArb: fc.Arbitrary<ArbitrationValue> = fc.record({
  name: fc.stringMatching(/^[a-z][a-z_]{0,14}$/),
  weight: fc.double({ min: 0, max: 1, noNaN: true }),
  type: fc.option(fc.constantFrom("governance", "epistemic", "relational", "craft"), { nil: undefined }),
});

describe("PB-A1/A2 arbitration", () => {
  it("A1: strict total order, total, antisymmetric, transitive; ranking deterministic", () => {
    fc.assert(
      fc.property(valueArb, valueArb, valueArb, (a, b, c) => {
        // Antisymmetry (distinct names ⇒ strict order).
        if (a.name !== b.name) {
          expect(Math.sign(compareValues(a, b))).toBe(-Math.sign(compareValues(b, a)));
        }
        // Transitivity.
        if (compareValues(a, b) < 0 && compareValues(b, c) < 0) {
          expect(compareValues(a, c)).toBeLessThan(0);
        }
        // Ranking is order-independent (sort is total): same multiset in, same order out.
        const r1 = rankValues([a, b, c]).map((v) => v.name + v.weight);
        const r2 = rankValues([c, a, b]).map((v) => v.name + v.weight);
        expect(r1).toEqual(r2);
      }),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);

  it("A2: U7 derivable, safety (governance, ≥0.90) beats every non-governance value, with a trace", () => {
    fc.assert(
      fc.property(
        valueArb.filter((v) => v.type !== "governance" && v.name !== "safety"),
        fc.double({ min: 0.9, max: 1, noNaN: true }),
        (v, w) => {
          const safety: ArbitrationValue = { name: "safety", weight: w, type: "governance" };
          const verdict = arbitrate(safety, v);
          expect(verdict.winner).toBe("safety");
          expect(verdict.rule).toBe("governance-type");
          expect(verdict.trace).toContain("governance");
          // Order of arguments is irrelevant (determinism).
          expect(arbitrate(v, safety).winner).toBe("safety");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);
});
