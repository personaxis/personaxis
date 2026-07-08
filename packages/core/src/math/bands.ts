/**
 * Behavior bands — the spec's denotational semantics for envelope values
 * (MATH_CORE.md Def. 6; SPEC v1.0 §L3: `bands: [b1, b2]`, drift ≡ band crossing).
 *
 * A band names WHICH behavior expression the compiler injects; the band interval
 * is the level set of the drift metric on that coordinate. A within-band move is
 * expression variance; a crossing is the normative drift event (recompile trigger).
 *
 * Boundaries live on the RAW value axis (spec-faithful). When a coordinate
 * declares no `bands`, the spec defaults apply on the unit scale — for envelopes
 * not on [0,1] the defaults are mapped affinely onto [min, max].
 */

import type { Envelope } from "../envelopes.js";

export type Band = "low" | "moderate" | "high";
export const BANDS: readonly Band[] = ["low", "moderate", "high"];

/** Spec default band boundaries on the unit scale (SPEC §6 L3). */
export const DEFAULT_BANDS: readonly [number, number] = [0.33, 0.66];

/** Resolve the effective [b1, b2] boundaries for an envelope (declared or default). */
export function bandBoundaries(e: Envelope): [number, number] {
  if (e.bands && e.bands.length === 2 && e.bands[0] < e.bands[1]) return [e.bands[0], e.bands[1]];
  // Defaults are defined on [0,1]; map affinely onto the envelope's raw axis so
  // non-unit envelopes still partition into three non-empty intervals.
  const span = e.max - e.min;
  if (e.min >= 0 && e.max <= 1) return [DEFAULT_BANDS[0], DEFAULT_BANDS[1]];
  return [e.min + span * DEFAULT_BANDS[0], e.min + span * DEFAULT_BANDS[1]];
}

/** The band of a value (Def. 6): low if x ≤ b1, moderate if b1 < x ≤ b2, else high. */
export function bandOf(value: number, e: Envelope): Band {
  const [b1, b2] = bandBoundaries(e);
  if (value <= b1) return "low";
  if (value <= b2) return "moderate";
  return "high";
}

/** True iff moving from → to crosses a band boundary (the normative drift event). */
export function bandCrossing(from: number, to: number, e: Envelope): boolean {
  return bandOf(from, e) !== bandOf(to, e);
}

/** A representative value inside each band (interval midpoints, clamped to the
 *  envelope) — used by the persona Jacobian (J_compile) and by tests. */
export function bandRepresentatives(e: Envelope): Record<Band, number> {
  const [b1, b2] = bandBoundaries(e);
  const clamp = (x: number) => Math.max(e.min, Math.min(e.max, x));
  return {
    low: clamp((e.min + Math.max(e.min, Math.min(b1, e.max))) / 2),
    moderate: clamp((Math.max(e.min, b1) + Math.min(e.max, b2)) / 2),
    high: clamp((Math.min(b2, e.max) + e.max) / 2),
  };
}

/**
 * Select the expression prose for a value. Normative form: a per-band map — only
 * the CURRENT band's prose is injected (deterministic compile, ADR-004). A plain
 * string applies regardless of band (accepted, deprecated). Returns null when the
 * coordinate declares no expression (a J_compile-zero "decorative" candidate).
 */
export function expressionFor(value: number, e: Envelope): string | null {
  if (e.expression === undefined) return null;
  if (typeof e.expression === "string") return e.expression;
  const band = bandOf(value, e);
  return e.expression[band] ?? null;
}
