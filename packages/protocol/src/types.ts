/**
 * The SQ/EQ vocabulary — the ONLY types a front-end and the engine share.
 *
 * Pattern from Codex (codex-rs/core/src/protocol.rs), adapted to TypeScript
 * discriminated unions:
 *   - Op        (submission queue): everything a front-end may ASK the engine.
 *   - EventMsg  (event queue): everything the engine TELLS its front-ends.
 *
 * The engine's internal LoopEvent (core EventBus) is carried verbatim inside
 * `engine.event` — the protocol does not re-model the living loop, it
 * transports it. Type-only import: nothing from core lands in the wire bundle.
 */

import type { LoopEvent } from "@personaxis/core";

export const PROTOCOL_VERSION = 1;

// ─── SQ: operations (front-end → engine) ─────────────────────────────────────

export type Op =
  /** Free-form user input for the living session (NL or /command line). */
  | { op: "user_input"; text: string }
  /** One governed Living-Loop tick on an observation. */
  | { op: "observe"; observation: string; source: "user" | "tool" | "internal" | "synthesis" }
  /** Clamped, audited state mutation (adjust_persona_state). */
  | { op: "adjust"; field: string; delta: number; reason: string }
  /** Answer to a pending `approval.requested` event. */
  | { op: "approval"; requestId: string; decision: "allow" | "deny" }
  /** Cancel the in-flight turn/agent run (best-effort). */
  | { op: "interrupt" }
  /** Current envelope values + recent mutations. */
  | { op: "state_get" }
  /** Mutation log + memory-chain integrity + anomalies. */
  | { op: "audit_get" }
  /** Change the self-improvement posture (governed; min-wins vs policy.yaml). */
  | { op: "improve"; mode: "locked" | "suggesting" | "autonomous" }
  /** Graceful engine shutdown (flushes writers, acks, then exits). */
  | { op: "shutdown" };

export type OpName = Op["op"];

/** Every op resolves to a result (JSON-RPC request/response). */
export interface OpResult {
  ok: boolean;
  /** Op-specific payload (state snapshot, audit view, applied mutation, …). */
  data?: unknown;
  error?: string;
}

// ─── EQ: events (engine → front-ends, JSON-RPC notifications) ────────────────

export type EventMsg =
  /** First event on connect: who is being served, under which posture. */
  | {
      event: "session.configured";
      sessionId: string;
      persona: { name: string; path: string };
      mode: "locked" | "suggesting" | "autonomous";
      protocolVersion: number;
    }
  /** A turn began processing (user input or observation accepted). */
  | { event: "turn.started"; turnId: string }
  /** Streaming text for the live region (frame-batched by the UI, not here). */
  | { event: "token.delta"; turnId: string; text: string }
  /** The turn finished; the transcript line can be committed to <Static>. */
  | { event: "turn.completed"; turnId: string }
  /** A tool call needs a human decision — answer with op `approval`. */
  | {
      event: "approval.requested";
      requestId: string;
      tool: string;
      args: Record<string, unknown>;
      reason: string;
    }
  /** An engine LoopEvent, verbatim (observe/appraise/govern/mutate/memory/…). */
  | { event: "engine.event"; payload: LoopEvent }
  /** Push snapshot after a mutation batch (dashboards re-render from this). */
  | { event: "state.snapshot"; values: Record<string, number>; mutationCount: number }
  /** Engine-side failure that did not kill the session. */
  | { event: "error"; message: string };

export type EventName = EventMsg["event"];

// ─── JSON-RPC method names (the wire contract) ───────────────────────────────

/** All ops travel as ONE request method; the union discriminates. */
export const RPC_SUBMIT = "personaxis/submit";
/** All events travel as ONE notification method; the union discriminates. */
export const RPC_EVENT = "personaxis/event";
/**
 * Connection handshake, answered by the transport itself (not the app handler).
 * Doubles as the registration barrier: when it resolves, the server side has
 * fully registered the connection — a subsequent broadcast WILL reach it.
 */
export const RPC_HELLO = "personaxis/hello";

export interface HelloResult {
  protocolVersion: number;
}
