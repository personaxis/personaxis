/**
 * u-space, the denotational coordinate system of the persona state
 * (MATH_CORE.md Defs. 3–5).
 *
 * Every mutable value gets a meaning: u = the fraction of the allowed deviation
 * (on that side of the mean) currently consumed. u(mean)=0, u(max)=+1, u(min)=−1.
 * The normalization is ASYMMETRIC, envelopes need not be centered on their mean, 
 * and per-side affine, so it is exact and order-preserving.
 *
 * `project` is the Euclidean projection Π_B onto the envelope box: idempotent,
 * nonexpansive, and FP-exact (min/max never round), which is why theorem T1
 * (invariance) holds with no epsilon.
 */

import type { Envelope } from "../envelopes.js";

/** u(x) ∈ [−1, 1]: fraction of allowed deviation consumed (Def. 4). Values outside
 *  the box map beyond ±1, useful for reporting a tampered state's true position. */
export function toU(value: number, e: Envelope): number {
  if (value >= e.mean) {
    const half = e.max - e.mean;
    return half > 0 ? (value - e.mean) / half : 0;
  }
  const half = e.mean - e.min;
  return half > 0 ? (value - e.mean) / half : 0;
}

/** Inverse of toU on [−1, 1] (Def. 4; per-side affine). */
export function fromU(u: number, e: Envelope): number {
  return u >= 0 ? e.mean + u * (e.max - e.mean) : e.mean + u * (e.mean - e.min);
}

/** Π_B for one coordinate: exact clamp (Def. 3). */
export function projectValue(value: number, e: Envelope): number {
  return Math.max(e.min, Math.min(e.max, value));
}

/** Π_B for a full state over its envelopes (missing fields seed at the mean). */
export function project(
  values: Record<string, number>,
  envelopes: Record<string, Envelope>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [field, e] of Object.entries(envelopes)) {
    out[field] = projectValue(values[field] ?? e.mean, e);
  }
  return out;
}

/** The drift metric ρ(x, y) = ‖u(x) − u(y)‖_∞ over shared envelope fields (Def. 5).
 *  ρ(S, μ) is drift-from-baseline; band boundaries are its per-coordinate level sets. */
export function rho(
  a: Record<string, number>,
  b: Record<string, number>,
  envelopes: Record<string, Envelope>,
): number {
  let max = 0;
  for (const [field, e] of Object.entries(envelopes)) {
    const ua = toU(a[field] ?? e.mean, e);
    const ub = toU(b[field] ?? e.mean, e);
    const d = Math.abs(ua - ub);
    if (d > max) max = d;
  }
  return max;
}
