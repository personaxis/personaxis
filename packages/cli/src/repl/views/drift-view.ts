/**
 * THE DRIFT MINIAPP: three planes, three tabs, every row openable.
 *
 * The previous view showed the same envelope block as /status and explained its symbols in
 * a caption. Two things follow from that, and both are structural rather than cosmetic:
 *
 *  - /drift and /status stop overlapping. /status answers "what am I now" (a snapshot);
 *    /drift answers "how far have I moved from what I declared, and in what" (a delta).
 *    The live-envelope block moved out of /status accordingly.
 *  - Every row is a DELTA with a magnitude and a before/after, in all three planes, and
 *    Enter opens the literal values. A row that cannot be opened is a row that is only
 *    telling you a number.
 *
 * Built on the same tabbed host and the same `scopedProvider` as the other miniapps, so
 * drift is readable for the main persona or any sub with one key, for free.
 */

import chalk from "chalk";
import {
  readState,
  extractEnvelopes,
  driftReport,
  readMaxStepDelta,
  readDriftThresholds,
  type DriftReport,
} from "@personaxis/core";
export { structuralReport, behavioralReport } from "./drift-data.js";
import {
  structuralReport,
  behavioralReport,
  changeDetailLines,
  changeSentence,
  magnitudeBar,
  brief,
} from "./drift-data.js";
import { scopedProvider } from "./scoped.js";
import type { Ctx } from "../types.js";
import type { TabbedProvider, TabLine, TabAction } from "./tabbed.js";

export const DRIFT_TABS = ["Continuous", "Structural", "Behavioral"] as const;

/** The numeric report, or undefined when the persona has no state yet. */
function continuousReport(ctx: Ctx): DriftReport | undefined {
  try {
    const st = readState(ctx.handle.statePath);
    const fm = ctx.handle.frontmatter as Record<string, unknown>;
    const env = extractEnvelopes(ctx.handle.frontmatter);
    return driftReport({
      values: st.values,
      envelopes: env.envelopes,
      maxStepDelta: readMaxStepDelta(fm),
      thresholds: readDriftThresholds(fm),
      protectedFields: env.protectedFields,
    });
  } catch {
    return undefined;
  }
}

/** Plane 1: u-space over envelope coordinates. */
export function continuousLines(ctx: Ctx): TabLine[] {
  const r = continuousReport(ctx);
  if (!r) {
    return [
      chalk.dim("  no state yet: nothing has moved this persona from its declared centre."),
      chalk.dim("  `personaxis state init` starts recording, then every mutation lands here."),
    ];
  }
  const out: TabLine[] = [
    chalk.dim("  numeric coordinates that declare an envelope: how much of the allowed room is used"),
    chalk.dim(`  D = ${r.global.toFixed(3)} (max |u|)  ·  step cap δ = ${r.maxStepDelta}`),
    "",
  ];
  for (const c of r.coordinates) {
    const dir = c.u > 0 ? "+" : c.u < 0 ? "−" : " ";
    const state = c.protected
      ? chalk.magenta("immutable")
      : c.decayAssisted
        ? chalk.dim("recovery exit (audited)")
        : chalk.dim(`≥${c.minStepsToCross} step(s) to cross into the next band`);
    out.push({
      label: c.field,
      value: `${magnitudeBar(Math.abs(c.u), 6)} u ${dir}${Math.abs(c.u).toFixed(2)}  ${chalk.bold(c.band)}  ${state}`,
      hint: `${c.field}: ${Math.round(Math.abs(c.u) * 100)}% of its declared room is used`,
    });
  }
  const withThreshold = r.layers.filter((l) => l.threshold !== undefined);
  if (withThreshold.length) {
    out.push("", chalk.bold("  Per-layer thresholds"));
    for (const l of withThreshold) {
      out.push(
        `  ${l.exceeded ? chalk.red("✗") : chalk.green("✓")} ${chalk.cyan(l.layer.padEnd(24))} D ${l.drift.toFixed(3)} / ${l.threshold}` +
          (l.exceeded ? chalk.red("  over its declared limit") : ""),
      );
    }
  }
  return out;
}

/** Plane 2: the per-field diff, every row opening onto its literal before/after. */
export function structuralLines(ctx: Ctx): TabLine[] {
  const r = structuralReport(ctx);
  const out: TabLine[] = [
    chalk.dim("  what personaxis.md DECLARES vs what is in force right now, field by field"),
    chalk.dim("  strings, lists, flags, numbers and shapes alike · Enter opens the literal values"),
    "",
  ];
  if (!r.changes.length) {
    out.push(chalk.green("  ✓ nothing has moved: every field in force is the one the spec declares."));
    out.push(
      chalk.dim("  applied self-edits would appear here; personaxis.md itself is never rewritten."),
    );
    return out;
  }
  out.push(
    chalk.dim(`  ${r.changes.length} field(s) differ · mean magnitude ${r.global.toFixed(2)}`),
    "",
  );
  for (const c of r.changes) {
    out.push({
      label: c.path,
      value:
        `${magnitudeBar(c.magnitude, 6)} ${changeSentence(c)}` +
        (c.policy ? chalk.dim(`   [${c.policy}]`) : ""),
      hint: `${brief(c.from, 24)} → ${brief(c.to, 24)}  ·  Enter shows both in full`,
      onEnter: (): TabAction => ({ kind: "drill", title: c.path, lines: () => changeDetailLines(c) }),
    });
  }
  return out;
}

/** Plane 3: how far the document the host agents actually read has moved. */
export function behavioralLines(ctx: Ctx): TabLine[] {
  const b = behavioralReport(ctx);
  const out: TabLine[] = [
    chalk.dim("  a change only changes behaviour if it changes the document the agents READ"),
    "",
    {
      label: "compiled shift",
      value:
        `${magnitudeBar(b.compiledShift, 6)} ` +
        (b.compiledShift === 0
          ? "the edits in force do not change the compiled document"
          : `${Math.round(b.compiledShift * 100)}% of its lines differ from the declared version`),
      hint: "measured by assembling the document both ways, offline and deterministically",
    },
    {
      label: "freshness",
      value: b.stale
        ? chalk.yellow(`⚠ ${b.staleReason ?? "out of date"}`)
        : chalk.green("✓ the agents are reading the current persona"),
      hint: b.stale
        ? "Enter recompiles so hosts read the current persona"
        : "the compiled document matches the spec in force",
      ...(b.stale
        ? {
            onEnter: (): TabAction => ({
              kind: "toast",
              text: "run /compile to refresh the document hosts read",
            }),
          }
        : {}),
    },
  ];
  if (b.turnsSinceChange !== undefined) {
    out.push({
      label: "evidence",
      value:
        b.turnsSinceChange === 0
          ? chalk.dim("0 turns since the last applied edit (not lived yet)")
          : `${b.turnsSinceChange} turn(s) recorded since the last applied edit`,
      hint: "how much real use has happened under the current version of this persona",
    });
  }
  if (b.lastChangeTs) {
    out.push("", chalk.dim(`  last applied edit: ${b.lastChangeTs.slice(0, 16).replace("T", " ")}`));
  }
  return out;
}

export function driftProvider(ctx: Ctx): TabbedProvider {
  return scopedProvider(ctx, (c) => ({
    title: "Drift",
    tabs: [...DRIFT_TABS],
    lines: (t): TabLine[] =>
      t === 0 ? continuousLines(c) : t === 1 ? structuralLines(c) : behavioralLines(c),
  }));
}

/** Plain-text projection of all three planes, for pipes and `--json`-less CI output. */
export function driftTextLines(ctx: Ctx): string[] {
  const render = (title: string, lines: TabLine[]): string[] => [
    chalk.bold(`  ${title}`),
    ...lines.map((l) => (typeof l === "string" ? l : `  ${chalk.cyan(l.label.padEnd(38))} ${l.value ?? ""}`)),
    "",
  ];
  return [
    ...render("Continuous plane", continuousLines(ctx)),
    ...render("Structural plane", structuralLines(ctx)),
    ...render("Behavioral plane", behavioralLines(ctx)),
  ];
}
