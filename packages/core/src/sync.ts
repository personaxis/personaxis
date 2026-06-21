/**
 * Cross-OS state reconciliation (F7 — plan/08-persona-model).
 *
 * The portable user-clone persona can live on Windows, Linux and macOS at once,
 * versioned via git. Identity (personaxis.md) is immutable and shared; only
 * state.json (envelope values + mutation_log) and memory diverge per machine.
 * This module merges two states WITHOUT clobbering either:
 *   - mutation_log: union, de-duplicated, time-ordered (the full audit survives);
 *   - values: last-writer-wins PER FIELD by the latest mutation timestamp across
 *     both logs, clamped to the envelope; ties/absent history are reported as
 *     conflicts rather than silently overwritten;
 *   - a merge marker is appended so the reconciliation itself is auditable.
 *
 * Deterministic, governed, reversible — never a blind overwrite.
 */

import type { Envelope } from "./envelopes.js";
import type { MutationLogEntry, StateFile } from "./persona.js";

export interface MergeConflict {
  field: string;
  a: number;
  b: number;
  chosen: number;
  reason: string;
}

export interface MergeResult {
  merged: StateFile;
  conflicts: MergeConflict[];
}

function clamp(v: number, e?: Envelope): number {
  if (!e) return v;
  return Math.max(e.min, Math.min(e.max, v));
}

function dedupeLog(entries: MutationLogEntry[]): MutationLogEntry[] {
  const seen = new Set<string>();
  const out: MutationLogEntry[] = [];
  for (const e of entries) {
    const key = `${e.ts}|${e.field}|${e.to}|${e.actor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((x, y) => x.ts.localeCompare(y.ts));
}

function latestForField(log: MutationLogEntry[], field: string): MutationLogEntry | undefined {
  let best: MutationLogEntry | undefined;
  for (const e of log) {
    if (e.field === field && (!best || e.ts > best.ts)) best = e;
  }
  return best;
}

/**
 * Merge state `b` into `a` (a = local/base). Returns the merged state + conflicts.
 */
export function mergeState(
  a: StateFile,
  b: StateFile,
  envelopes: Record<string, Envelope> = {},
): MergeResult {
  const mergedLog = dedupeLog([...(a.mutation_log ?? []), ...(b.mutation_log ?? [])]);
  const conflicts: MergeConflict[] = [];
  const fields = new Set([...Object.keys(a.values), ...Object.keys(b.values)]);
  const values: Record<string, number> = {};

  for (const f of fields) {
    const av = a.values[f];
    const bv = b.values[f];
    const latest = latestForField(mergedLog, f);
    let chosen: number;
    let reason: string;

    if (latest) {
      chosen = latest.to;
      reason = `latest mutation @ ${latest.ts} (${latest.actor})`;
    } else if (av === bv || bv === undefined) {
      chosen = av ?? bv;
      reason = "agreement / base-only";
    } else if (av === undefined) {
      chosen = bv;
      reason = "incoming-only";
    } else {
      chosen = av;
      reason = "no history, kept base (conflict)";
      conflicts.push({ field: f, a: av, b: bv, chosen, reason });
    }

    values[f] = clamp(chosen, envelopes[f]);
    if (latest && av !== undefined && bv !== undefined && av !== bv) {
      conflicts.push({ field: f, a: av, b: bv, chosen: values[f], reason });
    }
  }

  const marker: MutationLogEntry = {
    ts: new Date().toISOString(),
    field: "__merge__",
    from: 0,
    to: 0,
    delta_requested: 0,
    clamped: false,
    reason: `cross-machine reconciliation (${conflicts.length} conflict(s))`,
    actor: "runtime-context",
  };

  const merged: StateFile = {
    ...a,
    values,
    mutation_log: [...mergedLog, marker],
  };
  return { merged, conflicts };
}
