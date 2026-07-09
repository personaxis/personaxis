/**
 * PB-T4 — state.values is a deterministic fold of mutation_log (MATH_CORE.md §3).
 *
 *  - replaying the log reproduces the engine-produced values exactly (drift = ∅);
 *  - replay is deterministic (two runs, identical output);
 *  - random tamper of a stored, mutated value is DETECTED as drift;
 *  - governance-blocked entries (to === from) never move the replay.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { applyMutation, rebuildStateValues } from "../../src/index.js";
import { NUM_RUNS, envelopesArb, planArb, freshState, PROP_TIMEOUT } from "./arbitraries.js";

const historyArb = envelopesArb.chain((envs) =>
  fc.record({
    envs: fc.constant(envs),
    plan: planArb(Object.keys(envs).length),
    blockedMask: fc.array(fc.boolean(), { minLength: 60, maxLength: 60 }),
  }),
);

function runHistory(
  envs: Record<string, { mean: number; min: number; max: number }>,
  plan: [number, number][],
  blockedMask: boolean[],
) {
  const fields = Object.keys(envs);
  const state = freshState();
  plan.forEach(([idx, delta], k) => {
    applyMutation(state, envs, {
      field: fields[idx],
      delta,
      reason: "pb-t4",
      governanceBlocked: blockedMask[k] ?? false,
    });
  });
  return state;
}

describe("PB-T4 replay: the log is the state", () => {
  it("fold(log) ≡ engine values; no drift when untampered; deterministic", () => {
    fc.assert(
      fc.property(historyArb, ({ envs, plan, blockedMask }) => {
        const state = runHistory(envs, plan, blockedMask);
        const r1 = rebuildStateValues(envs, state.mutation_log, state.values);
        const r2 = rebuildStateValues(envs, state.mutation_log, state.values);
        expect(r1.drift).toEqual([]); // the engine's own output never disagrees with its log
        expect(r1.values).toEqual(r2.values); // determinism
        for (const [f, v] of Object.entries(state.values)) expect(r1.values[f]).toBe(v);
      }),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);

  it("tampering a mutated stored value is detected as drift naming that field", () => {
    fc.assert(
      fc.property(
        historyArb,
        fc.double({ min: 1e-6, max: 1e6, noNaN: true }),
        fc.boolean(),
        ({ envs, plan, blockedMask }, bump, negate) => {
          const state = runHistory(envs, plan, blockedMask);
          const mutated = [...new Set(state.mutation_log.map((e) => e.field))];
          fc.pre(mutated.length > 0);
          const victim = mutated[plan[0][0] % mutated.length];
          const tampered = { ...state.values, [victim]: state.values[victim] + (negate ? -bump : bump) };
          const r = rebuildStateValues(envs, state.mutation_log, tampered);
          expect(r.drift.map((d) => d.field)).toContain(victim);
          // And the rebuilt value is the log's truth, not the tampered one.
          expect(r.values[victim]).toBe(state.values[victim]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);

  it("blocked entries are inert in replay (to === from)", () => {
    fc.assert(
      fc.property(historyArb, ({ envs, plan }) => {
        const allBlocked = new Array(60).fill(true);
        const state = runHistory(envs, plan, allBlocked);
        for (const e of state.mutation_log) expect(e.to).toBe(e.from);
        const r = rebuildStateValues(envs, state.mutation_log, state.values);
        expect(r.drift).toEqual([]);
        // Every field still sits at its seed (the envelope mean, clamped nowhere).
        for (const e of state.mutation_log) expect(r.values[e.field]).toBe(e.from);
      }),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);
});
