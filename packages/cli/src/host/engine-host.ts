/**
 * EngineHost — binds the governed core engine to the protocol seam (FR.2).
 *
 * One host per persona process: front-ends (TUI, dashboard, headless scripts)
 * connect to the persona's deterministic pipe and drive the SAME engine the
 * REPL/MCP/HTTP use — every mutation clamped + audited, every observation
 * injection-scanned, evolution visible in every connected surface at once.
 *
 * The host owns NO business logic: ops map 1:1 onto core functions; the core
 * EventBus is re-broadcast verbatim as `engine.event`.
 */

import { randomUUID } from "node:crypto";
import {
  LivingLoop,
  HeuristicAppraiser,
  LlmAppraiser,
  resolveModel,
  loadPersona,
  ensureState,
  readState,
  writeState,
  withStateLock,
  extractEnvelopes,
  resolveField,
  applyMutation,
  readMemory,
  verifyMemoryChain,
  detectMemoryAnomalies,
  readMode,
  displayName,
  ApprovalBroker,
  type PersonaHandle,
  type LoopEvent,
} from "@personaxis/core";
import {
  ProtocolServer,
  pipePathFor,
  PROTOCOL_VERSION,
  type Op,
  type OpResult,
  type EventMsg,
} from "@personaxis/protocol";
import { runMode } from "../commands/improve.js";

export class EngineHost {
  readonly pipePath: string;
  readonly sessionId = randomUUID();
  private readonly server: ProtocolServer;
  private handle: PersonaHandle;
  private interrupted = false;
  /** FR.10: approvals outlive a render cycle and can be answered by ANY front. */
  readonly approvals = new ApprovalBroker();

  constructor(private readonly personaPath: string) {
    this.handle = loadPersona(personaPath);
    ensureState(this.handle);
    this.pipePath = pipePathFor(this.handle.personaPath);
    this.server = new ProtocolServer((op) => this.dispatch(op));
  }

  async listen(): Promise<void> {
    await this.server.listen(this.pipePath, (conn) => {
      this.server.send(conn, {
        event: "session.configured",
        sessionId: this.sessionId,
        persona: { name: displayName(this.handle.frontmatter), path: this.handle.personaPath },
        mode: readMode(this.handle.frontmatter as Record<string, unknown>, this.handle.personaPath),
        protocolVersion: PROTOCOL_VERSION,
      });
    });
  }

  close(): Promise<void> {
    return this.server.close();
  }

  private broadcast(event: EventMsg): void {
    this.server.broadcast(event);
  }

  /**
   * FR.10: open an approval — broadcast `approval.requested` to every front and
   * await whichever answers (or the fail-closed timeout). The agent loop (F3)
   * passes this as its onApproval, replacing the non-interactive auto-deny.
   */
  requestApproval(
    tool: string,
    args: Record<string, unknown>,
    reason: string,
    timeoutMs = 120_000,
  ): Promise<"allow" | "deny"> {
    const { decision } = this.approvals.request(tool, args, reason, {
      timeoutMs,
      onRequest: (r) =>
        this.broadcast({
          event: "approval.requested",
          requestId: r.requestId,
          tool: r.tool,
          args: r.args,
          reason: r.reason,
        }),
    });
    return decision;
  }

  private snapshot(): void {
    const st = readState(this.handle.statePath);
    this.broadcast({
      event: "state.snapshot",
      values: st.values,
      mutationCount: st.mutation_log.length,
    });
  }

  private async dispatch(op: Op): Promise<OpResult> {
    switch (op.op) {
      // FR scope: free-form input runs a governed observation tick. The full
      // conversational brain (responder + slash-router) moves behind this seam
      // in F3.6 (REPL split) — recorded in IMPLEMENTATION_CHECKLIST.
      case "user_input":
        return this.observe(op.text, "user");
      case "observe":
        return this.observe(op.observation, op.source);
      case "adjust": {
        const env = extractEnvelopes(this.handle.frontmatter);
        const field = resolveField(op.field, env.envelopes);
        if (!(field in env.envelopes)) {
          return { ok: false, error: `no envelope declared for '${op.field}'` };
        }
        const result = withStateLock(this.handle.statePath, () => {
          const st = readState(this.handle.statePath);
          const r = applyMutation(st, env.envelopes, {
            field,
            delta: op.delta,
            reason: op.reason,
            actor: "actor-llm",
          });
          writeState(this.handle.statePath, st);
          return r;
        });
        this.snapshot();
        return { ok: !result.blocked, data: result };
      }
      case "state_get": {
        const st = readState(this.handle.statePath);
        return { ok: true, data: { values: st.values, recent_mutations: st.mutation_log.slice(-5) } };
      }
      case "audit_get": {
        const st = readState(this.handle.statePath);
        const mem = readMemory(this.handle.personaPath);
        return {
          ok: true,
          data: {
            mutation_log: st.mutation_log.slice(-10),
            memory_entries: mem.length,
            memory_chain_intact: verifyMemoryChain(this.handle.personaPath).ok,
            anomalies: detectMemoryAnomalies(mem),
          },
        };
      }
      case "improve": {
        const r = runMode(this.handle.personaPath, op.mode);
        this.handle = loadPersona(this.personaPath); // posture is identity-level: reload
        return { ok: true, data: r };
      }
      case "interrupt":
        this.interrupted = true;
        return { ok: true };
      case "approval": {
        const decided = this.approvals.decide(op.requestId, op.decision);
        return decided
          ? { ok: true }
          : { ok: false, error: `no pending approval with id '${op.requestId}'` };
      }
      case "shutdown":
        setImmediate(() => void this.close());
        return { ok: true };
    }
  }

  private async observe(observation: string, source: "user" | "tool" | "internal" | "synthesis"): Promise<OpResult> {
    if (!observation.trim()) return { ok: false, error: "observation must be non-empty" };
    this.interrupted = false;
    const turnId = randomUUID();
    this.broadcast({ event: "turn.started", turnId });
    const m = resolveModel({
      personaPath: this.handle.personaPath,
      frontmatter: this.handle.frontmatter as Record<string, unknown>,
    });
    const loop = new LivingLoop(this.handle.personaPath, {
      appraiser: m ? new LlmAppraiser({ ...m, timeoutMs: 30_000 }) : new HeuristicAppraiser(),
    });
    loop.bus.on((e: LoopEvent) => this.broadcast({ event: "engine.event", payload: e }));
    try {
      const report = await loop.tick({ observation, source });
      this.snapshot();
      this.broadcast({ event: "turn.completed", turnId });
      return { ok: true, data: report };
    } catch (e) {
      this.broadcast({ event: "error", message: (e as Error).message });
      this.broadcast({ event: "turn.completed", turnId });
      return { ok: false, error: (e as Error).message };
    }
  }
}
