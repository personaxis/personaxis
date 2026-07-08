/**
 * F3.8 — the appraiser's EVOLUTION VIEW.
 *
 * Before this, the appraiser proposed changes blind: it saw the mutable field
 * NAMES and the editable section names, but not the CURRENT value of each field,
 * its envelope, or the improvement mode. So it could propose "nudge mood.tone up"
 * without knowing mood.tone is already at the top of its range.
 *
 * The evolution view is the grounded projection of the editable surface: for
 * each mutable field, its current value, envelope [min,max], and a band telling
 * the model where the value sits and how much headroom remains; plus the
 * improvement mode and the sections open to qualitative self-edits. The model
 * proposes deltas against reality, and the runtime still clamps/governs/audits.
 */

import type { Envelope } from "./envelopes.js";
import { bandOf as specBandOf } from "./math/bands.js";

export interface EvolutionField {
  path: string;
  current: number;
  mean: number;
  min: number;
  max: number;
  /** Where `current` sits in [min,max]. */
  band: "at-min" | "low" | "mid" | "high" | "at-max";
  /** Room to move down / up before hitting the envelope, rounded. */
  headroomDown: number;
  headroomUp: number;
}

export interface EvolutionView {
  /** improvement_policy.mode — locked disables self-edits entirely. */
  mode: string;
  fields: EvolutionField[];
  /** Top-level sections open to qualitative self-edits (editGate != block). */
  editableSections: string[];
}

function bandOf(current: number, e: Envelope): EvolutionField["band"] {
  if (current <= e.min + 1e-9) return "at-min";
  if (current >= e.max - 1e-9) return "at-max";
  // F6.2: honor the coordinate's DECLARED behavior bands (spec defaults otherwise)
  // instead of fixed positional cuts — the appraiser sees the same bands the
  // compiler and the drift metric use (single semantics, MATH_CORE.md Def. 6).
  const band = specBandOf(current, e);
  return band === "moderate" ? "mid" : band;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Build the grounded evolution view from current state + envelopes + mode. */
export function buildEvolutionView(args: {
  values: Record<string, number>;
  envelopes: Record<string, Envelope>;
  editableSections: string[];
  mode: string;
}): EvolutionView {
  const fields: EvolutionField[] = [];
  for (const [path, e] of Object.entries(args.envelopes)) {
    const current = args.values[path] ?? e.mean;
    fields.push({
      path,
      current: r2(current),
      mean: r2(e.mean),
      min: r2(e.min),
      max: r2(e.max),
      band: bandOf(current, e),
      headroomDown: r2(current - e.min),
      headroomUp: r2(e.max - current),
    });
  }
  return { mode: args.mode, fields, editableSections: args.editableSections };
}

/** Render the evolution view as compact prompt text for the appraiser. */
export function renderEvolutionView(view: EvolutionView): string {
  const lines: string[] = [];
  lines.push(`# Evolution view (improvement mode: ${view.mode})`);
  if (view.mode === "locked") {
    lines.push("Self-improvement is LOCKED — do not propose selfEdits; envelope nudges still allowed.");
  }
  lines.push("## Mutable envelope fields — current value, range, and headroom:");
  if (view.fields.length === 0) {
    lines.push("(none)");
  } else {
    for (const f of view.fields) {
      lines.push(
        `- ${f.path}: current ${f.current} in [${f.min}, ${f.max}] (${f.band}); ` +
          `headroom ↓${f.headroomDown} ↑${f.headroomUp}`,
      );
    }
  }
  lines.push("## Sections open to qualitative self-edits:");
  lines.push(view.editableSections.length ? view.editableSections.join(", ") : "(none — do not propose selfEdits)");
  return lines.join("\n");
}
