/**
 * /rewind (V2-F3.D19). Undo the last N state mutations WITHOUT rewriting
 * history: compute the values as they were before those mutations (envelope
 * means + a replay of the truncated log), then append restoring mutations. The
 * hash-chained mutation_log is never truncated, the rewind is itself audited,
 * so T3 tamper-evidence survives.
 */

import { applyMutation, type StateFile, type Envelope } from "@personaxis/core";

export function rewindState(
  state: StateFile,
  envelopes: Record<string, Envelope>,
  n: number,
): { changed: string[]; steps: number } {
  const log = state.mutation_log ?? [];
  const steps = Math.max(1, Math.floor(n) || 1);
  const keep = Math.max(0, log.length - steps);

  // Target = the state before the last `steps` mutations: means, then replay the kept log.
  const target: Record<string, number> = {};
  for (const [field, env] of Object.entries(envelopes)) target[field] = env.mean;
  for (const entry of log.slice(0, keep)) {
    if (entry.field in target) target[entry.field] = entry.to;
  }

  const changed: string[] = [];
  for (const field of Object.keys(envelopes)) {
    const current = state.values[field] ?? envelopes[field].mean;
    const want = target[field];
    if (Math.abs(want - current) > 1e-9) {
      applyMutation(state, envelopes, {
        field,
        delta: want - current,
        reason: `rewind ${steps}`,
        actor: "human-operator",
      });
      changed.push(field);
    }
  }
  return { changed, steps };
}
