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
 *  - mutation_log chain: entries chain like the episodic ledger; any tamper of
 *    a chained entry is detected; a legacy (unhashed) prefix is tolerated.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  applyMutation,
  applyHomeostasis,
  decayRate,
  verifyMutationChain,
  arbitrate,
  compareValues,
  rankValues,
  toU,
  bandOf,
  bandBoundaries,
  coordinateDrift,
  type ArbitrationValue,
  type Envelope,
  type MutationLogEntry,
} from "../../src/index.js";
import { NUM_RUNS, envelopeArb, freshState, deltaArb, PROP_TIMEOUT } from "./arbitraries.js";

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
          const state = freshState();
          const start = up ? e.mean + (e.max - e.mean) * frac : e.mean - (e.mean - e.min) * frac;
          state.values["affect.baseline.mood.tone"] = start;
          const lambda = decayRate(h);

          let dev = Math.abs(start - e.mean);
          for (let t = 0; t < 30; t++) {
            const results = applyHomeostasis(state, envs);
            const v = state.values["affect.baseline.mood.tone"];
            const newDev = Math.abs(v - e.mean);
            if (results.length === 0) {
              // Below epsilon: converged. Deviation must already be tiny relative to λ.
              expect(newDev).toBeLessThanOrEqual(dev + 1e-12);
              break;
            }
            // Exact contraction: dev' = (1−λ)·dev, within FP tolerance.
            expect(newDev).toBeCloseTo((1 - lambda) * dev, 6);
            expect(v).toBeGreaterThanOrEqual(e.min);
            expect(v).toBeLessThanOrEqual(e.max);
            expect(results[0].entry.actor).toBe("runtime-decay");
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
          const state = freshState();
          const lambda = decayRate(h);
          const bound = deltaMax / lambda;

          // Warm-up ratio: after k ticks the transient has decayed by (1−λ)^k;
          // assert the bound only once the transient term is below 5% of it.
          let transient = Math.max(e.max - e.mean, e.mean - e.min);
          for (const raw of noise) {
            applyHomeostasis(state, envs);
            // Adversary: pushes a bounded delta each tick (sign from generated noise).
            const delta = Math.sign(raw || 1) * deltaMax;
            applyMutation(state, envs, { field: "affect.baseline.mood.tone", delta, reason: "iss forcing" });
            transient *= 1 - lambda;
            const dev = Math.abs(state.values["affect.baseline.mood.tone"] - e.mean);
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
          const state = freshState();
          const start = up ? e.mean + (e.max - e.mean) * frac : e.mean - (e.mean - e.min) * frac;
          state.values["affect.baseline.mood.tone"] = start;
          const uBefore = toU(start, env);
          applyHomeostasis(state, envs);
          const uAfter = toU(state.values["affect.baseline.mood.tone"], env);
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
          const state = freshState();
          state.values["affect.baseline.mood.tone"] = e.mean;
          const startBand = bandOf(e.mean, env);
          if (startBand === "high" || b2 >= e.max) return; // no upward crossing available
          const floor = Math.ceil((b2 - e.mean) / deltaMax);
          let gateSteps = 0;
          for (let t = 0; t < floor + 40; t++) {
            applyHomeostasis(state, envs);
            applyMutation(state, envs, { field: "affect.baseline.mood.tone", delta: deltaMax, reason: "pb-t3-decay push" });
            gateSteps++;
            if (bandOf(state.values["affect.baseline.mood.tone"], env) === "high") break;
          }
          const crossed = bandOf(state.values["affect.baseline.mood.tone"], env) === "high";
          if (crossed) {
            expect(gateSteps).toBeGreaterThanOrEqual(floor);
            // Once outside the baseline's band, the exit back is decay-reachable:
            // the report must say so.
            const d = coordinateDrift("affect.baseline.mood.tone", state.values["affect.baseline.mood.tone"], env, deltaMax);
            expect(d.decayAssisted).toBe(true);
          }
          // At the baseline's own band the floor is certified: never decayAssisted.
          const atMean = coordinateDrift("affect.baseline.mood.tone", e.mean, env, deltaMax);
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

describe("mutation_log hash chain (T3 forensic upgrade)", () => {
  const historyArb = envelopeArb.chain((e) =>
    fc.record({
      e: fc.constant(e),
      deltas: fc.array(deltaArb, { minLength: 2, maxLength: 20 }),
      pick: fc.nat(1000),
      fieldToTamper: fc.constantFrom("to", "from", "reason", "actor", "ts", "delta_requested", "prev_hash", "hash"),
    }),
  );

  it("engine-produced logs verify; ANY tamper of a chained entry is detected", () => {
    fc.assert(
      fc.property(historyArb, ({ e, deltas, pick, fieldToTamper }) => {
        const envs = { "personality.traits.x": e };
        const state = freshState();
        for (const d of deltas) {
          applyMutation(state, envs, { field: "personality.traits.x", delta: d, reason: "chain" });
        }
        expect(verifyMutationChain(state.mutation_log).ok).toBe(true);
        expect(verifyMutationChain(state.mutation_log).chained).toBe(deltas.length);

        const idx = pick % state.mutation_log.length;
        const victim = { ...state.mutation_log[idx] } as Record<string, unknown>;
        victim[fieldToTamper] =
          typeof victim[fieldToTamper] === "number"
            ? (victim[fieldToTamper] as number) + 1
            : `${String(victim[fieldToTamper])}~t`;
        const tampered = [...state.mutation_log];
        tampered[idx] = victim as unknown as MutationLogEntry;
        const v = verifyMutationChain(tampered);
        expect(v.ok).toBe(false);
        expect(v.brokenAt).toBeLessThanOrEqual(Math.min(idx + 1, tampered.length - 1));
      }),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);

  it("a legacy (unhashed) prefix is tolerated; interior deletion of chained entries is detected", () => {
    fc.assert(
      fc.property(historyArb, ({ e, deltas, pick }) => {
        const envs = { "personality.traits.x": e };
        const state = freshState();
        // Legacy prefix: entries without hash (pre-1.1 logs).
        const legacy: MutationLogEntry = {
          ts: "2025-01-01T00:00:00.000Z",
          field: "personality.traits.x",
          from: e.mean,
          to: e.mean,
          delta_requested: 0,
          clamped: false,
          reason: "legacy",
          actor: "human-operator",
        };
        state.mutation_log.push(legacy);
        for (const d of deltas) {
          applyMutation(state, envs, { field: "personality.traits.x", delta: d, reason: "chain" });
        }
        const v0 = verifyMutationChain(state.mutation_log);
        expect(v0.ok).toBe(true);
        expect(v0.chained).toBe(deltas.length);
        // Interior deletion among the CHAINED entries (never the tail).
        const chainedStart = 1;
        const deletable = state.mutation_log.length - 1 - chainedStart;
        fc.pre(deletable >= 1);
        const idx = chainedStart + (pick % deletable);
        const cut = state.mutation_log.filter((_, k) => k !== idx);
        expect(verifyMutationChain(cut).ok).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);
});
