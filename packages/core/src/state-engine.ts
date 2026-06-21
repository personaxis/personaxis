/**
 * State engine — the canonical, programmatic mutation primitive.
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

import type { Envelope } from "./envelopes.js";
import type { MutationLogEntry, StateFile } from "./persona.js";

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

  const entry: MutationLogEntry = {
    ts: new Date().toISOString(),
    field: req.field,
    from: current,
    to: next,
    delta_requested: req.delta,
    clamped,
    reason: req.reason,
    actor: req.actor ?? "human-operator",
    tool_call_id: req.toolCallId,
    governance_blocked: blocked,
    origin_node: req.originNode,
    session_id: req.sessionId,
  };

  state.values[req.field] = next;
  state.mutation_log = state.mutation_log ?? [];
  state.mutation_log.push(entry);

  return { entry, from: current, to: next, clamped, blocked };
}
