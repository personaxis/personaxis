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

/** One coordinate's pull toward its baseline, before anything writes it down. */
export interface HomeostaticMove {
  field: string;
  delta: number;
  reason: string;
}

/**
 * What one homeostatic step would move, and by how much.
 *
 * Pure: values in, moves out, no state file and nothing written. Split out for the
 * same reason `decide` was split from `mutate`, and the split is what lets the record
 * write these entries with an author and provenance instead of the old log's five-word
 * actor. `applyHomeostasis` keeps its shape on top of this while the old engine is
 * still there.
 *
 * Deviations below `epsilon` are skipped, so a coordinate that has effectively
 * returned home stops generating microscopic entries forever.
 */
export function homeostaticMoves(
  values: Record<string, number>,
  envelopes: Record<string, Envelope>,
  opts?: { epsilon?: number },
): HomeostaticMove[] {
  const epsilon = opts?.epsilon ?? 1e-4;
  const moves: HomeostaticMove[] = [];
  for (const { field, lambda, halfLife } of decayingFields(envelopes)) {
    const e = envelopes[field];
    const current = values[field] ?? e.mean;
    const delta = lambda * (e.mean - current);
    if (Math.abs(delta) < epsilon) continue;
    moves.push({
      field,
      delta,
      reason: `homeostatic decay toward baseline (half_life ${halfLife})`,
    });
  }
  return moves;
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
  const results: MutationResult[] = [];
  for (const move of homeostaticMoves(state.values, envelopes, opts)) {
    results.push(
      applyMutation(state, envelopes, {
        ...move,
        actor: "runtime-decay",
        sessionId: opts?.sessionId,
        originNode: opts?.originNode,
      }),
    );
  }
  return results;
}
