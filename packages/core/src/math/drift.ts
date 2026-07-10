/**
 * Drift — a real metric with declared meaning (MATH_CORE.md Def. 5, T3).
 *
 * Per coordinate: d = |u| ∈ [0,1], the fraction of allowed deviation consumed.
 * Per layer: D_L = max over the layer's coordinates — compared against the spec's
 * `governance.drift_thresholds.<layer>` (a MUST field that, before F6.2, nothing
 * computed). Global: D = max over all coordinates.
 *
 * The report also carries theorem T3 live: the minimum number of audited
 * mutation-log entries any non-human trajectory needs before this coordinate can
 * cross its next band boundary — the "evidence cost" a buyer can point at.
 */

import type { Envelope } from "../envelopes.js";
import { toU } from "./uspace.js";
import { bandOf, bandBoundaries, type Band } from "./bands.js";

export interface CoordinateDrift {
  field: string;
  value: number;
  /** u ∈ [−1,1] (beyond ±1 iff the stored value was tampered outside the box). */
  u: number;
  /** d = |u| — drift-from-baseline for this coordinate. */
  drift: number;
  band: Band;
  /** Raw distance to the nearest band boundary (0 when sitting on one). */
  toNextBoundary: number;
  /** T3 live: ⌈distance/δ_max⌉, the minimum GATE-ADMITTED audited steps before this
   *  coordinate can cross its next band boundary. Infinity when the coordinate
   *  backs a hard-enforced virtue (gate-immutable). Certified floor for every
   *  crossing that increases |u| (the adversarial direction); when the exit
   *  boundary lies toward the baseline AND the coordinate declares half_life,
   *  audited homeostatic decay can reach it in fewer steps: `decayAssisted`. */
  minStepsToCross: number;
  /** PA-1: true when the exit boundary is toward the baseline on a half_life
   *  coordinate, so the T3 floor does not bound that (recovery) crossing. Decay
   *  steps are still audited runtime-decay entries; only the count floor lifts. */
  decayAssisted: boolean;
  /** True when the coordinate backs a hard virtue — no runtime actor may move it. */
  protected: boolean;
  headroomUp: number;
  headroomDown: number;
}

export interface LayerDrift {
  layer: string;
  /** D_L = max drift over the layer's coordinates. */
  drift: number;
  /** Declared governance.drift_thresholds.<layer>, when present. */
  threshold?: number;
  exceeded: boolean;
  fields: string[];
}

export interface DriftReport {
  coordinates: CoordinateDrift[];
  layers: LayerDrift[];
  /** D = max over all coordinates. */
  global: number;
  maxStepDelta: number;
}

/** The spec layer a state key belongs to (first dot segment of the full path;
 *  legacy short keys map onto their v1.0 layer). */
export function layerOfField(field: string): string {
  if (field.startsWith("traits.")) return "personality";
  if (field.startsWith("mood.") || field.startsWith("affect.")) return "affect";
  if (field.startsWith("drives.")) return "values_and_drives";
  return field.split(".")[0];
}

export function coordinateDrift(
  field: string,
  value: number,
  e: Envelope,
  maxStepDelta: number,
  isProtected = false,
): CoordinateDrift {
  const u = toU(value, e);
  const [b1, b2] = bandBoundaries(e);
  const band = bandOf(value, e);
  // Distance to the nearest boundary of the CURRENT band (crossing target).
  const candidates =
    band === "low" ? [b1 - value] : band === "high" ? [value - b2] : [value - b1, b2 - value];
  const toNextBoundary = Math.max(0, Math.min(...candidates));
  const minStepsToCross = isProtected
    ? Infinity // gate-immutable: no runtime trajectory crosses, ever (governance.ts)
    : maxStepDelta > 0
      ? Math.max(1, Math.ceil(toNextBoundary / maxStepDelta))
      : Infinity;
  // PA-1 direction check: when the value's band no longer contains the baseline,
  // the only exit boundary points back toward the mean; homeostatic decay (if
  // declared) crosses it in audited steps that are exempt from the gate cap.
  // When the band still contains the mean, either exit increases |u| and decay
  // can only oppose the move, so the floor is certified.
  const decayAssisted =
    !isProtected &&
    typeof e.halfLife === "number" &&
    e.halfLife > 0 &&
    bandOf(e.mean, e) !== band;
  return {
    field,
    value,
    u,
    drift: Math.abs(u),
    band,
    toNextBoundary,
    minStepsToCross,
    decayAssisted,
    protected: isProtected,
    headroomUp: e.max - value,
    headroomDown: value - e.min,
  };
}

/** Build the full drift report for a state (MATH_CORE.md §8: `driftReport`). */
export function driftReport(args: {
  values: Record<string, number>;
  envelopes: Record<string, Envelope>;
  maxStepDelta: number;
  /** governance.drift_thresholds from the frontmatter, when declared. */
  thresholds?: Record<string, number>;
  /** EnvelopeLookup.protectedFields — hard-virtue-backed coordinates (T3 = ∞). */
  protectedFields?: string[];
}): DriftReport {
  const coordinates: CoordinateDrift[] = [];
  for (const [field, e] of Object.entries(args.envelopes)) {
    coordinates.push(
      coordinateDrift(
        field,
        args.values[field] ?? e.mean,
        e,
        args.maxStepDelta,
        args.protectedFields?.includes(field) ?? false,
      ),
    );
  }
  coordinates.sort((a, b) => b.drift - a.drift);

  const byLayer = new Map<string, CoordinateDrift[]>();
  for (const c of coordinates) {
    const layer = layerOfField(c.field);
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), c]);
  }
  const layers: LayerDrift[] = [...byLayer.entries()].map(([layer, coords]) => {
    const drift = Math.max(...coords.map((c) => c.drift));
    const threshold = args.thresholds?.[layer];
    return {
      layer,
      drift,
      threshold,
      exceeded: typeof threshold === "number" && drift > threshold,
      fields: coords.map((c) => c.field),
    };
  });
  layers.sort((a, b) => b.drift - a.drift);

  return {
    coordinates,
    layers,
    global: coordinates.length > 0 ? Math.max(...coordinates.map((c) => c.drift)) : 0,
    maxStepDelta: args.maxStepDelta,
  };
}

/** Read governance.drift_thresholds from frontmatter (per-layer floats 0..1). */
export function readDriftThresholds(frontmatter: Record<string, unknown>): Record<string, number> {
  const g = frontmatter.governance as { drift_thresholds?: Record<string, unknown> } | undefined;
  const out: Record<string, number> = {};
  for (const [layer, v] of Object.entries(g?.drift_thresholds ?? {})) {
    if (typeof v === "number" && v >= 0 && v <= 1) out[layer] = v;
  }
  return out;
}
