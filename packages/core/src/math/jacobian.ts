/**
 * The persona Jacobian — external sensitivity of behavior to state coordinates
 * (MATH_CORE.md Defs. 10–11; the external analogue of the Jacobian-lens reading).
 *
 * J_compile (this module, exact + offline): the deterministic compile stage is a
 * STEP FUNCTION of each coordinate's band, so its sensitivity is computable
 * exactly — compile the persona at each reachable band's representative value and
 * measure the normalized distance between adjacent bands' artifacts. Distance is
 * line-level edit distance (the artifact is line-structured markdown; the band
 * stage swaps whole lines), normalized by the larger document's line count.
 *
 * σ_i = 0 means the coordinate is DECORATIVE: no value it can take changes the
 * compiled artifact — the audit's F-21 "numbers are decorative" made detectable
 * (and lintable). σ ranks which coordinates actually matter.
 *
 * J_behavior (Def. 11) is the probe-based estimator over a live model (BYOK); it
 * lives with the experiment harness (packages/evals, RQ3) — this module supplies
 * the band patches it uses.
 */

import type { Envelope } from "../envelopes.js";
import { bandOf, bandRepresentatives, BANDS, type Band } from "./bands.js";

export interface CoordinateSensitivity {
  field: string;
  /** σ ∈ [0,1]: mean normalized line-edit distance between adjacent reachable bands. */
  sigma: number;
  /** Bands actually reachable inside the envelope (an envelope narrower than a
   *  band's interval cannot reach it). */
  reachableBands: Band[];
  /** Per adjacent-pair distances, e.g. {"low→moderate": 0.04}. */
  pairs: Record<string, number>;
  decorative: boolean;
}

export interface JacobianReport {
  coordinates: CoordinateSensitivity[];
  /** Compiles performed (cost transparency: ≤ 3 per coordinate + 1 baseline). */
  compiles: number;
}

/** Line-level edit distance (Levenshtein over lines), normalized to [0,1]. */
export function normalizedLineDistance(a: string, b: string): number {
  if (a === b) return 0;
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1),
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m] / Math.max(n, m);
}

/** Bands whose representative value actually falls in that band (reachability). */
export function reachableBands(e: Envelope): Band[] {
  const reps = bandRepresentatives(e);
  return BANDS.filter((b) => bandOf(reps[b], e) === b);
}

/**
 * Compute J_compile for every envelope coordinate. `compile` is the deterministic
 * artifact function (state values → compiled document) — the caller binds the
 * assembler with the persona/target; this module owns only the mathematics.
 */
export function jacobianCompile(args: {
  envelopes: Record<string, Envelope>;
  /** Current state values (non-patched coordinates stay at these). */
  values: Record<string, number>;
  compile: (values: Record<string, number>) => string;
}): JacobianReport {
  let compiles = 0;
  const memo = new Map<string, string>();
  const compileAt = (values: Record<string, number>): string => {
    const key = JSON.stringify(values);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const doc = args.compile(values);
    compiles++;
    memo.set(key, doc);
    return doc;
  };

  const coordinates: CoordinateSensitivity[] = [];
  for (const [field, e] of Object.entries(args.envelopes)) {
    const bands = reachableBands(e);
    const reps = bandRepresentatives(e);
    const pairs: Record<string, number> = {};
    const dists: number[] = [];
    for (let i = 0; i + 1 < bands.length; i++) {
      const docA = compileAt({ ...args.values, [field]: reps[bands[i]] });
      const docB = compileAt({ ...args.values, [field]: reps[bands[i + 1]] });
      const d = normalizedLineDistance(docA, docB);
      pairs[`${bands[i]}→${bands[i + 1]}`] = d;
      dists.push(d);
    }
    const sigma = dists.length > 0 ? dists.reduce((s, d) => s + d, 0) / dists.length : 0;
    coordinates.push({ field, sigma, reachableBands: bands, pairs, decorative: sigma === 0 });
  }
  coordinates.sort((a, b) => b.sigma - a.sigma);
  return { coordinates, compiles };
}

/**
 * Static decorativeness check (no compile needed) — the lint's cheap variant.
 * A coordinate provably cannot change the compiled artifact when it declares no
 * expression, a plain-string expression (band-independent), or a band map whose
 * REACHABLE bands all resolve to the same prose (missing variants fall back to
 * nothing, which also collapses the step function).
 */
export function staticallyDecorative(e: Envelope): boolean {
  if (e.expression === undefined) return true;
  if (typeof e.expression === "string") return true;
  const bands = reachableBands(e);
  const variants = new Set(bands.map((b) => (e.expression as Partial<Record<Band, string>>)[b] ?? ""));
  return variants.size <= 1;
}
