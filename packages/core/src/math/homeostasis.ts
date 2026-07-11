/**
 * Homeostasis, opt-in return-to-baseline dynamics (MATH_CORE.md T6).
 *
 * A coordinate may declare `half_life: h` (turns, spec v1.1 MAY field). Each tick,
 * BEFORE the gate admits new deltas, the deviation from the mean decays by
 * λ = 1 − 2^(−1/h): the deviation halves every h turns absent stimulus. Because
 * the decayed value is a convex combination of two in-box points (value, mean),
 * decay NEVER needs clamping and never leaves the box.
 *
 * Theorem T6 (machine-checked in PB-T6): without forcing the state contracts
 * geometrically to μ; under bounded forcing |δ| ≤ δ_max the standing deviation is
 * bounded by δ_max/λ, input-to-state stability, a formula of two spec numbers.
 *
 * Every decay is a REAL audited mutation (actor `runtime-decay`, an enum value the
 * log has reserved since v0.6), homeostasis is visible history, not hidden math.
 */

import type { Envelope } from "../envelopes.js";
import type { StateFile } from "../persona.js";
import { applyMutation, type MutationResult } from "../state-engine.js";

/** λ from a half-life in turns: the per-turn retention is 2^(−1/h). */
export function decayRate(halfLife: number): number {
  return halfLife > 0 ? 1 - Math.pow(2, -1 / halfLife) : 0;
}

/** Coordinates of `envelopes` that declare a half_life, with their λ. */
export function decayingFields(
  envelopes: Record<string, Envelope>,
): Array<{ field: string; lambda: number; halfLife: number }> {
  const out: Array<{ field: string; lambda: number; halfLife: number }> = [];
  for (const [field, e] of Object.entries(envelopes)) {
    if (typeof e.halfLife === "number" && e.halfLife > 0) {
      out.push({ field, lambda: decayRate(e.halfLife), halfLife: e.halfLife });
    }
  }
  return out;
}

/**
 * Apply one homeostatic step to `state` in place (audited via applyMutation).
 * Deviations below `epsilon` are left untouched, the log stays free of
 * microscopic decay entries once a coordinate has effectively returned home.
 */
export function applyHomeostasis(
  state: StateFile,
  envelopes: Record<string, Envelope>,
  opts?: { epsilon?: number; sessionId?: string; originNode?: string },
): MutationResult[] {
  const epsilon = opts?.epsilon ?? 1e-4;
  const results: MutationResult[] = [];
  for (const { field, lambda, halfLife } of decayingFields(envelopes)) {
    const e = envelopes[field];
    const current = state.values[field] ?? e.mean;
    const delta = lambda * (e.mean - current);
    if (Math.abs(delta) < epsilon) continue;
    results.push(
      applyMutation(state, envelopes, {
        field,
        delta,
        reason: `homeostatic decay toward baseline (half_life ${halfLife})`,
        actor: "runtime-decay",
        sessionId: opts?.sessionId,
        originNode: opts?.originNode,
      }),
    );
  }
  return results;
}
