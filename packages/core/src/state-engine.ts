/**
 * State engine, the canonical, programmatic mutation primitive.
 *
 * This is the same clamp + audit logic the CLI's `state mutate` command applies,
 * lifted to a pure function so the Living Loop (and the managed runtime) can call
 * it directly. Mirrors the runtime tool `adjust_persona_state(field, delta, reason)`.
 *
 * Guarantees (spec-faithful, non-negotiable):
 *  - every delta is clamped to the declared envelope [min, max];
 *  - every mutation appends an immutable, timestamped entry to mutation_log;
 *  - clamping is recorded (`clamped: true`) for full auditability.
 */

import { createHash } from "node:crypto";
import type { Envelope } from "./envelopes.js";
import type { MutationLogEntry, StateFile } from "./persona.js";

/** v1.1 chain hash: commits to the entry's audit-relevant fields + prev link. */
function hashMutationEntry(
  e: Pick<
    MutationLogEntry,
    "ts" | "field" | "from" | "to" | "delta_requested" | "clamped" | "reason" | "actor" | "governance_blocked" | "prev_hash"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ts: e.ts,
        field: e.field,
        from: e.from,
        to: e.to,
        delta_requested: e.delta_requested,
        clamped: e.clamped,
        reason: e.reason,
        actor: e.actor,
        governance_blocked: e.governance_blocked ?? false,
        prev_hash: e.prev_hash ?? "",
      }),
    )
    .digest("hex");
}

/** Hash of the last CHAINED entry in a log ("" when none are chained yet). */
function lastMutationHash(log: MutationLogEntry[] | undefined): string {
  if (!log) return "";
  for (let i = log.length - 1; i >= 0; i--) {
    if (typeof log[i].hash === "string") return log[i].hash as string;
  }
  return "";
}

/**
 * Verify the mutation_log hash chain (T3's forensic half, mirroring the episodic
 * ledger's T5). Pre-1.1 entries carry no hash, a LEGACY PREFIX is tolerated, but
 * once an entry is chained every later entry must chain correctly; any edit,
 * reorder, insertion, or interior deletion of chained entries breaks verification.
 */
export function verifyMutationChain(
  log: MutationLogEntry[],
): { ok: boolean; brokenAt?: number; chained: number } {
  let prev = "";
  let chained = 0;
  let sawChained = false;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (typeof e.hash !== "string") {
      // Legacy (pre-1.1) entry: allowed only before the chain starts.
      if (sawChained) return { ok: false, brokenAt: i, chained };
      continue;
    }
    sawChained = true;
    if ((e.prev_hash ?? "") !== prev) return { ok: false, brokenAt: i, chained };
    if (hashMutationEntry(e) !== e.hash) return { ok: false, brokenAt: i, chained };
    prev = e.hash;
    chained++;
  }
  return { ok: true, chained };
}

export interface MutationRequest {
  field: string;
  delta: number;
  reason: string;
  actor?: MutationLogEntry["actor"];
  toolCallId?: string;
  /** Set by the governance gate when a mutation is refused. */
  governanceBlocked?: boolean;
  /** v0.8: machine/instance origin (cross-OS reconciliation). */
  originNode?: string;
  /** v0.8: runtime session id. */
  sessionId?: string;
}

export interface MutationResult {
  entry: MutationLogEntry;
  from: number;
  to: number;
  clamped: boolean;
  blocked: boolean;
}

/**
 * Apply one mutation to `state` in place. Returns the audit result.
 * If `req.governanceBlocked` is true the value is NOT changed; only an audit
 * entry recording the blocked attempt is appended.
 */
export function applyMutation(
  state: StateFile,
  envelopes: Record<string, Envelope>,
  req: MutationRequest,
): MutationResult {
  const envelope = envelopes[req.field];
  if (!envelope) {
    throw new Error(
      `No envelope declared for '${req.field}'. Mutable fields: ${Object.keys(envelopes).join(", ")}`,
    );
  }
  if (!Number.isFinite(req.delta)) {
    throw new Error(`Invalid delta for '${req.field}': ${req.delta}`);
  }

  const current = state.values[req.field] ?? envelope.mean;
  const blocked = req.governanceBlocked === true;
  const requested = current + req.delta;
  const clampedTo = Math.max(envelope.min, Math.min(envelope.max, requested));
  const next = blocked ? current : clampedTo;
  const clamped = !blocked && clampedTo !== requested;

  const prevHash = lastMutationHash(state.mutation_log);
  const base = {
    ts: new Date().toISOString(),
    field: req.field,
    from: current,
    to: next,
    delta_requested: req.delta,
    clamped,
    reason: req.reason,
    actor: req.actor ?? ("human-operator" as const),
    governance_blocked: blocked,
    prev_hash: prevHash,
  };
  const entry: MutationLogEntry = {
    ...base,
    tool_call_id: req.toolCallId,
    origin_node: req.originNode,
    session_id: req.sessionId,
    // v1.1 (T3 forensic): every entry chains to its predecessor, like episodic memory.
    hash: hashMutationEntry(base),
  };

  state.values[req.field] = next;
  state.mutation_log = state.mutation_log ?? [];
  state.mutation_log.push(entry);

  return { entry, from: current, to: next, clamped, blocked };
}
