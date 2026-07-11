/**
 * PB-T1 / PB-T2, the box is a deterministic safe set (MATH_CORE.md §3).
 *
 * T1 Invariance: no sequence of mutations, adversarial deltas included, leaves
 *    the envelope box; an out-of-box (hand-tampered) value re-enters in one step.
 * T2 Bounded step: |to − from| ≤ |delta_requested| whenever from is in the box
 *    (the clamp is nonexpansive along the step); with the gate's cap this yields
 *    ‖S_{t+1} − S_t‖_∞ ≤ δ_max.
 *
 * These run against the REAL mutation primitive (applyMutation), not a model of it.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { applyMutation, governMutations, type EnvelopeLookup } from "../../src/index.js";
import { NUM_RUNS, envelopesArb, planArb, deltaArb, envelopeArb, freshState, PROP_TIMEOUT } from "./arbitraries.js";

describe("PB-T1 invariance: the box is inescapable", () => {
  it("every value stays in [min,max] under arbitrary mutation sequences", () => {
    fc.assert(
      fc.property(
        envelopesArb.chain((envs) =>
          fc.tuple(fc.constant(envs), planArb(Object.keys(envs).length)),
        ),
        ([envs, plan]) => {
          const fields = Object.keys(envs);
          const state = freshState();
          for (const [idx, delta] of plan) {
            const field = fields[idx];
            const r = applyMutation(state, envs, { field, delta, reason: "pb-t1" });
            const e = envs[field];
            // The just-written value AND the audit record are in-box.
            expect(r.to).toBeGreaterThanOrEqual(e.min);
            expect(r.to).toBeLessThanOrEqual(e.max);
            expect(state.values[field]).toBe(r.to);
          }
          // Post-condition over the whole state: S ∈ B, exactly (no epsilon, min/max are FP-exact).
          for (const [field, v] of Object.entries(state.values)) {
            expect(v).toBeGreaterThanOrEqual(envs[field].min);
            expect(v).toBeLessThanOrEqual(envs[field].max);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);

  it("one-step recovery: a tampered out-of-box value re-enters B on the next mutation", () => {
    fc.assert(
      fc.property(envelopeArb, deltaArb, deltaArb, (e, tamper, delta) => {
        const envs = { "personality.traits.x": e };
        const state = freshState();
        state.values["personality.traits.x"] = e.max + Math.abs(tamper) + 1; // outside
        const r = applyMutation(state, envs, { field: "personality.traits.x", delta, reason: "pb-t1-recovery" });
        expect(r.to).toBeGreaterThanOrEqual(e.min);
        expect(r.to).toBeLessThanOrEqual(e.max);
      }),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);

  it("blocked mutations move nothing (to === from) and still audit", () => {
    fc.assert(
      fc.property(envelopeArb, deltaArb, (e, delta) => {
        const envs = { "personality.traits.x": e };
        const state = freshState();
        const r = applyMutation(state, envs, {
          field: "personality.traits.x",
          delta,
          reason: "pb-t1-blocked",
          governanceBlocked: true,
        });
        expect(r.to).toBe(r.from);
        expect(r.blocked).toBe(true);
        expect(state.mutation_log.at(-1)?.governance_blocked).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);
});

describe("PB-T2 bounded step: the clamp is nonexpansive", () => {
  it("|to − from| ≤ |delta| when starting inside the box", () => {
    fc.assert(
      fc.property(envelopeArb, deltaArb, fc.double({ min: 0, max: 1, noNaN: true }), (e, delta, frac) => {
        const envs = { "personality.traits.x": e };
        const state = freshState();
        // Seed strictly inside the box (convex combination of the bounds).
        state.values["personality.traits.x"] = e.min + (e.max - e.min) * frac;
        const r = applyMutation(state, envs, { field: "personality.traits.x", delta, reason: "pb-t2" });
        // FP: |to−from| can exceed |delta| only by rounding of (from+delta); allow 1e-9 (engine tolerance).
        expect(Math.abs(r.to - r.from)).toBeLessThanOrEqual(Math.abs(delta) + 1e-9);
      }),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);

  it("clamped flag ⟺ the request exceeded the envelope (audit truthfulness)", () => {
    fc.assert(
      fc.property(envelopeArb, deltaArb, (e, delta) => {
        const envs = { "personality.traits.x": e };
        const state = freshState();
        const r = applyMutation(state, envs, { field: "personality.traits.x", delta, reason: "pb-t2-flag" });
        const requested = r.from + delta;
        const exceeded = requested < e.min || requested > e.max;
        expect(r.clamped).toBe(exceeded && r.to !== requested);
      }),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);

  // PB-T2-compose (PA-2, FASE 7 foundations review): k same-field proposals must
  // NOT slip k·δ_max of net movement through the gate. The gate folds admitted
  // deltas per field and re-bounds the net, so the tick applies at most one
  // composed mutation per coordinate with |δ| ≤ δ_max.
  it("PB-T2-compose: the gate folds same-field proposals; net admitted delta ≤ δ_max", () => {
    fc.assert(
      fc.property(
        envelopeArb,
        fc.array(deltaArb, { minLength: 2, maxLength: 6 }),
        fc.double({ min: 0.01, max: 0.5, noNaN: true }),
        (e, deltas, maxStep) => {
          const lookup: EnvelopeLookup = {
            envelopes: { "personality.traits.x": e },
            hardEnforcedVirtues: [],
          };
          const decision = governMutations(
            deltas.map((delta) => ({ field: "personality.traits.x", delta, reason: "pb-t2-compose" })),
            lookup,
            { mode: "autonomous", maxStepDelta: maxStep },
          );
          // One composed admission per field, net inside the cap.
          expect(decision.admitted.length).toBeLessThanOrEqual(1);
          for (const a of decision.admitted) {
            expect(Math.abs(a.delta)).toBeLessThanOrEqual(maxStep + 1e-12);
          }
          // Applying the composed admission moves the state by at most δ_max (T2).
          const state = freshState();
          state.values["personality.traits.x"] = e.mean;
          for (const a of decision.admitted) {
            const r = applyMutation(state, lookup.envelopes, { ...a });
            expect(Math.abs(r.to - r.from)).toBeLessThanOrEqual(maxStep + 1e-9);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);
});
