/**
 * DRIFT, THE THREE PLANES.
 *
 * Drift used to cover only the coordinates that declare an envelope, because that is where
 * u-space exists. But a spec is mostly strings, arrays and booleans, and those change too.
 * The first attempt at covering them added a QUALITATIVE block that only COUNTED governed
 * edits per layer, which is not a measurement: it says a layer moved without saying what
 * moved, from what, or by how much.
 *
 * Drift now has three planes, and every one of them reports a magnitude:
 *
 *   1. CONTINUOUS   u-space over envelope coordinates. What existed before.
 *   2. STRUCTURAL   the per-field diff of the declared spec against the one in force,
 *                   for strings, arrays, booleans, numbers and shapes alike
 *                   (`structuralDrift` in core). Every row carries before/after.
 *   3. BEHAVIORAL   how far the COMPILED document moves because of those edits, measured
 *                   by assembling it both ways, plus whether the document the host agents
 *                   are reading right now is still the current one.
 *
 * Plane 3 is what a reader actually cares about: a change that does not move the compiled
 * document does not change behaviour, and a compiled document that is out of date means the
 * agents are reading a persona that no longer exists. Both are computed offline and
 * deterministically, the assembler is stage-1 and no model is called.
 */

import chalk from "chalk";
import { dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  proposals,
  activeOverlay,
  applyOverlay,
  readRecompilePending,
  structuralDrift,
  normalizedLineDistance,
  assemblePersonaDoc,
  readEvaluations,
  type StructuralChange,
  type StructuralDriftReport,
} from "@personaxis/core";
import { loadManifest, hashContent } from "../../manifest.js";
import { isSubagentPath, slugAddressFromPath, compiledPathFor } from "../../load.js";
import type { Ctx } from "../types.js";

// ── plane 2: structural ───────────────────────────────────────────────────────

/**
 * The declared spec and the one in force. An applied self-edit never rewrites
 * personaxis.md; it lands in an overlay, so both sides already exist on disk and the diff
 * needs no snapshot file.
 */
export function declaredAndLive(personaPath: string, frontmatter: Record<string, unknown>): {
  declared: Record<string, unknown>;
  live: Record<string, unknown>;
} {
  const overlay = activeOverlay(personaPath);
  return { declared: frontmatter, live: applyOverlay(frontmatter, overlay) };
}

export function structuralReport(ctx: Ctx): StructuralDriftReport {
  const { declared, live } = declaredAndLive(ctx.handle.personaPath, ctx.handle.frontmatter as Record<string, unknown>);
  return structuralDrift(declared, live);
}

// ── plane 3: behavioral ───────────────────────────────────────────────────────

export interface BehavioralReport {
  /** 0..1 line distance between the document as DECLARED and as it stands now. */
  compiledShift: number;
  /** True when the compiled document on disk no longer matches the current spec. */
  stale: boolean;
  /** Why it is stale, in one phrase, or undefined when it is not. */
  staleReason?: string;
  /** Turns recorded since the most recent applied edit (evidence the change is lived). */
  turnsSinceChange?: number;
  /** ISO timestamp of the most recent applied edit. */
  lastChangeTs?: string;
}

/** Assemble the persona document deterministically, with and without the overlay. */
function assembleBothWays(ctx: Ctx): { declaredDoc: string; liveDoc: string } {
  const personaPath = ctx.handle.personaPath;
  const fm = ctx.handle.frontmatter as Record<string, unknown>;
  const isSub = isSubagentPath(personaPath);
  const target = {
    name: ctx.name,
    isSubagent: isSub,
    slug: isSub ? slugAddressFromPath(personaPath).split("/").pop() : undefined,
    resourceBase: isSub ? "./" : "./.personaxis/",
  };
  const declaredDoc = assemblePersonaDoc({ persona: fm, target });
  const liveDoc = assemblePersonaDoc({ persona: fm, target, appliedOverlay: activeOverlay(personaPath) });
  return { declaredDoc, liveDoc };
}

export function behavioralReport(ctx: Ctx): BehavioralReport {
  const personaPath = ctx.handle.personaPath;
  let compiledShift = 0;
  try {
    const { declaredDoc, liveDoc } = assembleBothWays(ctx);
    compiledShift = normalizedLineDistance(declaredDoc, liveDoc);
  } catch {
    compiledShift = 0; // a spec the assembler cannot read is reported by /doctor, not here
  }

  // Is what the host agents READ still the current persona?
  let stale = false;
  let staleReason: string | undefined;
  const pending = readRecompilePending(personaPath);
  if (pending.pending) {
    stale = true;
    staleReason = pending.reason || "a governed self-edit marked the document stale";
  } else {
    const manifest = loadManifest(dirname(personaPath));
    if (!existsSync(compiledPathFor(personaPath))) {
      stale = true;
      staleReason = "never compiled: no document exists for a host to read";
    } else if (manifest?.personaxisMdHash) {
      try {
        if (hashContent(readFileSync(personaPath, "utf-8")) !== manifest.personaxisMdHash) {
          stale = true;
          staleReason = "the spec text changed since the last compile";
        }
      } catch {
        /* unreadable spec is /doctor's business */
      }
    }
  }

  // Evidence: turns recorded after the most recent applied edit.
  const applied = proposals(personaPath).filter((p) => p.status === "applied");
  const lastChangeTs = applied
    .map((p) => (p as { ts?: string }).ts)
    .filter((t): t is string => Boolean(t))
    .sort()
    .pop();
  let turnsSinceChange: number | undefined;
  if (lastChangeTs) {
    try {
      turnsSinceChange = readEvaluations(personaPath).filter(
        (e) => typeof (e as { ts?: string }).ts === "string" && (e as { ts: string }).ts > lastChangeTs,
      ).length;
    } catch {
      turnsSinceChange = undefined;
    }
  }
  return { compiledShift, stale, staleReason, turnsSinceChange, lastChangeTs };
}

// ── rendering ─────────────────────────────────────────────────────────────────

/** A magnitude as a short bar plus its number, on the one scale all planes share. */
export function magnitudeBar(m: number, w = 10): string {
  const filled = Math.max(0, Math.min(w, Math.round(m * w)));
  const paint = m >= 0.6 ? chalk.red : m >= 0.25 ? chalk.yellow : chalk.green;
  return paint("▰".repeat(filled)) + chalk.dim("▱".repeat(w - filled));
}

/** A value rendered short enough to sit in a row, whatever its type. */
export function brief(v: unknown, max = 34): string {
  if (v === undefined) return "(absent)";
  if (v === null) return "null";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * One change, in a sentence a person can read. The kind decides the verb, so the row says
 * what HAPPENED rather than naming a metric.
 */
export function changeSentence(c: StructuralChange): string {
  switch (c.kind) {
    case "text":
      return `rewritten (${Math.round(c.magnitude * 100)}% of the text differs)`;
    case "flag":
      return `flipped ${brief(c.from)} → ${brief(c.to)}`;
    case "number":
      return `moved ${brief(c.from)} → ${brief(c.to)}`;
    case "list":
      return c.magnitude === 0.25 ? "same entries, different order" : "entries added or removed";
    case "added":
      return "added (the declaration does not have this field)";
    case "removed":
      return "removed (the declaration has it, the live persona does not)";
    case "shape":
      return "replaced by a different kind of value";
  }
}

/** The literal before/after of one field. */
export function changeDetailLines(c: StructuralChange): string[] {
  return [
    chalk.dim(`  ${c.path}`),
    "",
    `  ${chalk.cyan("layer")}      ${c.layer}${c.policy ? chalk.dim(`  ·  edit policy: ${c.policy}`) : ""}`,
    `  ${chalk.cyan("change")}     ${changeSentence(c)}`,
    `  ${chalk.cyan("magnitude")}  ${magnitudeBar(c.magnitude)} ${c.magnitude.toFixed(2)}`,
    "",
    chalk.bold("  Declared in personaxis.md"),
    ...String(typeof c.from === "string" ? c.from : JSON.stringify(c.from, null, 2) ?? "(absent)")
      .split("\n")
      .slice(0, 12)
      .map((l) => chalk.dim("  │ ") + l),
    "",
    chalk.bold("  In force now"),
    ...String(typeof c.to === "string" ? c.to : JSON.stringify(c.to, null, 2) ?? "(absent)")
      .split("\n")
      .slice(0, 12)
      .map((l) => chalk.green("  │ ") + l),
    "",
    chalk.dim("  applied self-edits live in an overlay; personaxis.md is never rewritten"),
    chalk.dim("  revert one with /review, or accept it by editing the spec yourself"),
  ];
}

/**
 * The structural plane as lines (shared by the view and the pipe fallback).
 * Kept as the single source of the wording so both surfaces say the same thing.
 */
export function structuralDriftLines(ctx: Ctx): string[] {
  const r = structuralReport(ctx);
  const out: string[] = [
    chalk.bold("Structural plane") +
      chalk.dim("  what the spec DECLARES vs what is in force, field by field, any type"),
  ];
  if (!r.changes.length) {
    out.push(chalk.dim("  nothing: every field in force is the one personaxis.md declares"));
    return out;
  }
  for (const c of r.changes.slice(0, 12)) {
    out.push(
      `  ${magnitudeBar(c.magnitude, 6)} ${chalk.cyan(c.path.padEnd(38))} ${changeSentence(c)}`,
    );
    out.push(
      `  ${" ".repeat(7)}${chalk.dim(`${brief(c.from)}  →  `)}${chalk.green(brief(c.to))}` +
        (c.policy ? chalk.dim(`   [${c.policy}]`) : ""),
    );
  }
  if (r.changes.length > 12) out.push(chalk.dim(`  …and ${r.changes.length - 12} more field(s)`));
  return out;
}

/** The behavioral plane as lines. */
export function behavioralDriftLines(ctx: Ctx): string[] {
  const b = behavioralReport(ctx);
  const out: string[] = [
    chalk.bold("Behavioral plane") + chalk.dim("  how far the document the agents READ has moved"),
  ];
  out.push(
    `  ${magnitudeBar(b.compiledShift, 6)} ${chalk.cyan("compiled shift".padEnd(38))} ` +
      (b.compiledShift === 0
        ? "the edits do not change the compiled document"
        : `${Math.round(b.compiledShift * 100)}% of its lines differ from the declared version`),
  );
  out.push(
    b.stale
      ? `  ${chalk.yellow("⚠")}      ${chalk.cyan("freshness".padEnd(38))} ${chalk.yellow(b.staleReason ?? "out of date")}` +
        chalk.dim("  ·  /compile refreshes it")
      : `  ${chalk.green("✓")}      ${chalk.cyan("freshness".padEnd(38))} the agents are reading the current persona`,
  );
  if (b.turnsSinceChange !== undefined) {
    out.push(
      `  ${" ".repeat(7)}${chalk.cyan("evidence".padEnd(38))} ${b.turnsSinceChange} turn(s) recorded since the last applied edit` +
        (b.turnsSinceChange === 0 ? chalk.dim("  (not lived yet)") : ""),
    );
  }
  return out;
}

// ── V5 compatibility: the ledger summary, kept as a fourth, smaller signal ─────
//
// The counts are still worth showing (a queue of pending edits is actionable), but they are
// no longer presented AS the qualitative drift: they are the ledger's tally, under the
// planes that actually measure movement.

function layerOf(targetPath: string): string {
  return targetPath.split(".")[0] || targetPath;
}

export interface QualitativeLayerChange {
  layer: string;
  applied: number;
  pending: number;
  lastTs?: string;
}

export interface QualitativeReport {
  layers: QualitativeLayerChange[];
  totalApplied: number;
  totalPending: number;
  specChangedSinceCompile: boolean;
  recompilePending: boolean;
}

export function qualitativeReport(personaPath: string): QualitativeReport {
  const all = proposals(personaPath);
  const byLayer = new Map<string, QualitativeLayerChange>();
  for (const x of all) {
    if (x.status !== "applied" && x.status !== "pending") continue;
    const layer = layerOf(x.targetPath);
    const slot = byLayer.get(layer) ?? { layer, applied: 0, pending: 0 };
    if (x.status === "applied") slot.applied += 1;
    else slot.pending += 1;
    const ts = (x as { ts?: string }).ts;
    if (ts && (!slot.lastTs || ts > slot.lastTs)) slot.lastTs = ts;
    byLayer.set(layer, slot);
  }
  const layers = [...byLayer.values()].sort((a, b) => b.applied + b.pending - (a.applied + a.pending));
  const manifest = loadManifest(dirname(personaPath));
  let specChanged = false;
  if (manifest?.personaxisMdHash && existsSync(personaPath)) {
    try {
      specChanged = hashContent(readFileSync(personaPath, "utf-8")) !== manifest.personaxisMdHash;
    } catch {
      specChanged = false;
    }
  }
  return {
    layers,
    totalApplied: layers.reduce((n, l) => n + l.applied, 0),
    totalPending: layers.reduce((n, l) => n + l.pending, 0),
    specChangedSinceCompile: specChanged,
    recompilePending: readRecompilePending(personaPath).pending,
  };
}

/**
 * The two NEW planes, rendered together, for the DriftView and for pipes. The continuous
 * plane is rendered by the caller (it owns the envelope report), so this is what gets
 * appended beneath it.
 */
export function qualitativeDriftLines(ctx: Ctx): string[] {
  const r = qualitativeReport(ctx.handle.personaPath);
  const lines = [...structuralDriftLines(ctx), "", ...behavioralDriftLines(ctx)];
  if (r.totalPending) {
    lines.push(
      "",
      chalk.yellow(`  ${r.totalPending} pending self-edit(s)`) +
        chalk.dim(" not in force yet · /review decides them"),
    );
  }
  return lines;
}
