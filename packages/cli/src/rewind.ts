/**
 * /rewind. Undo the last N state mutations WITHOUT rewriting history.
 *
 * Work out the values as they were before those mutations (envelope means plus a
 * replay of the truncated log), then move the coordinates back with ordinary
 * recorded moves. Nothing is ever truncated: the rewind is itself written down, so
 * the chain stays intact and an audit can see that somebody undid something, which is
 * a fact worth keeping rather than one to erase.
 *
 * ## Planning and moving are separate, and they were not
 *
 * This used to compute the target and apply it in one pass, straight into the state
 * file. Two callers then persisted the result and a third only previewed it, so the
 * same function was a simulation for one caller and a write for the others, and it
 * was recorded as neither: the moves went into `state.json` on the old path while the
 * record knew nothing about them.
 *
 * `rewindPlan` says what would move and writes nothing. A caller that only shows it
 * stops there; a caller that means it hands the plan to the record.
 */

import { record, type StateFile, type Envelope } from "@personaxis/core";

/** One coordinate's way back, with the reason a reader will see in the record. */
export interface RewindMove {
  field: string;
  delta: number;
  reason: string;
  /** Where it is now, so a preview can show the move without applying it. */
  from: number;
  /** Where it would land. Inside the envelope by construction: it was there before. */
  to: number;
}

/** What undoing the last `n` mutations would move, and writing nothing. */
export function rewindPlan(
  state: StateFile,
  envelopes: Record<string, Envelope>,
  n: number,
): { moves: RewindMove[]; steps: number } {
  const log = state.mutation_log ?? [];
  const steps = Math.max(1, Math.floor(n) || 1);
  const keep = Math.max(0, log.length - steps);

  // The state before the last `steps` mutations: means, then replay the kept log.
  const target: Record<string, number> = {};
  for (const [field, env] of Object.entries(envelopes)) target[field] = env.mean;
  for (const entry of log.slice(0, keep)) {
    if (entry.field in target) target[entry.field] = entry.to;
  }

  const moves: RewindMove[] = [];
  for (const field of Object.keys(envelopes)) {
    const from = state.values[field] ?? envelopes[field].mean;
    const to = target[field];
    if (Math.abs(to - from) <= 1e-9) continue;
    moves.push({ field, delta: to - from, reason: `rewind ${steps}`, from, to });
  }
  return { moves, steps };
}

/**
 * Undo the last `n` mutations, recorded.
 *
 * The author comes from the caller and is not defaulted here. A rewind is somebody
 * deciding to take something back, which is exactly the entry a reader will want
 * attributed correctly, and a default author is how a component ends up signing a
 * person's decision.
 */
export async function rewind(
  personaPath: string,
  statePath: string,
  state: StateFile,
  envelopes: Record<string, Envelope>,
  n: number,
  who: Parameters<typeof record.adjust>[3],
): Promise<{ changed: string[]; steps: number }> {
  const { moves, steps } = rewindPlan(state, envelopes, n);
  if (moves.length === 0) return { changed: [], steps };

  await record.adjustAll(personaPath, statePath, envelopes, () =>
    moves.map((m) => ({
      author: who,
      request: { field: m.field, delta: m.delta, reason: m.reason },
    })),
  );
  return { changed: moves.map((m) => m.field), steps };
}
