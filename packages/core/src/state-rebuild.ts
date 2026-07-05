/**
 * F3.4 — state.json as a REBUILDABLE CHECKPOINT of the mutation_log.
 *
 * The mutation_log is the append-only source of truth: every value change is an
 * audited entry recording its resulting value (`to`). So `state.values` is a
 * derived checkpoint — reconstructable by replaying the log from the envelope
 * means. This makes state.json recoverable (a corrupt/torn values block can be
 * rebuilt from the log) and tamper-evident (a hand-edited value that the log
 * does not justify shows up as drift).
 *
 * Replay is exact and deterministic: each entry already stores the post-clamp,
 * post-governance result, so folding the log — `values[field] = entry.to` —
 * reproduces the canonical values for every MUTATED field. A governance-blocked
 * entry has `to === from`, so it correctly leaves the value unchanged.
 *
 * SAFETY: the log is authoritative ONLY over fields it has touched. A field with
 * no log history is preserved from the stored value as-is (falling back to the
 * envelope mean only when it is absent from both) — a `rebuild --write` never
 * resets an un-mutated field, so it is safe even when state keys and log field
 * keys are spelled inconsistently (the pre-v1.0 short-key vs full dot-path gap).
 */

import type { Envelope } from "./envelopes.js";
import type { MutationLogEntry, StateFile } from "./persona.js";

export interface RebuildDrift {
  field: string;
  stored: number | undefined;
  rebuilt: number;
}

export interface RebuildResult {
  /** The values reconstructed purely from envelope means + the mutation_log. */
  values: Record<string, number>;
  /** Fields where the STORED value disagrees with the rebuilt one (tamper/corruption). */
  drift: RebuildDrift[];
}

/**
 * Reconstruct `values` from envelope means + the mutation_log, and report any
 * field whose stored value disagrees with the replay.
 */
export function rebuildStateValues(
  envelopes: Record<string, Envelope>,
  mutationLog: MutationLogEntry[],
  storedValues: Record<string, number> = {},
): RebuildResult {
  // 1. preserve the stored values (un-mutated fields are never reset).
  const values: Record<string, number> = { ...storedValues };
  // 2. seed declared-but-absent envelope fields from their mean.
  for (const [field, env] of Object.entries(envelopes)) {
    if (values[field] === undefined) values[field] = env.mean;
  }
  // 3. replay the log; each entry's `to` is authoritative for the fields it touched.
  const mutated = new Set<string>();
  for (const entry of mutationLog) {
    values[entry.field] = entry.to;
    mutated.add(entry.field);
  }

  // 4. drift = a MUTATED field whose stored value disagrees with the replay
  //    (the log is the source of truth; the stored value was tampered/torn).
  const drift: RebuildDrift[] = [];
  for (const field of mutated) {
    const rebuilt = values[field];
    const stored = storedValues[field];
    if (stored === undefined || Math.abs(stored - rebuilt) > 1e-9) {
      drift.push({ field, stored, rebuilt });
    }
  }
  return { values, drift };
}

/**
 * Return a copy of `state` with `values` rebuilt from its mutation_log (+ the
 * envelope means). The mutation_log itself is preserved verbatim — this is a
 * checkpoint refresh, never a history rewrite.
 */
export function rebuildState(state: StateFile, envelopes: Record<string, Envelope>): { state: StateFile; drift: RebuildDrift[] } {
  const { values, drift } = rebuildStateValues(envelopes, state.mutation_log ?? [], state.values ?? {});
  return { state: { ...state, values }, drift };
}
