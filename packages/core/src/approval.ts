/**
 * Approval broker (FR.10 — the minimal slice of Codex's approval state
 * machine): request → deliver → await → gate.
 *
 * Why a broker instead of an inline prompt: an approval must OUTLIVE a single
 * prompt/render cycle — the agent keeps waiting while the question travels to
 * whichever front-end answers it (TUI, dashboard, another protocol client).
 * States are explicit and auditable; an undecided request can time out to a
 * DENY (never to an allow).
 */

import { randomUUID } from "node:crypto";

export type ApprovalState = "requested" | "delivered" | "decided" | "expired";
export type BrokerDecision = "allow" | "deny";

export interface ApprovalRequest {
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  state: ApprovalState;
  createdAt: string;
  decidedAt?: string;
  decision?: BrokerDecision;
}

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (d: BrokerDecision) => void;
  timer?: NodeJS.Timeout;
}

export class ApprovalBroker {
  private readonly entries = new Map<string, PendingEntry>();

  /**
   * Open a request and await its decision. `onRequest` is the delivery
   * callback (broadcast to front-ends); when nobody decides within
   * `timeoutMs` the request EXPIRES to a deny — fail-closed, always.
   */
  request(
    tool: string,
    args: Record<string, unknown>,
    reason: string,
    opts: { onRequest?: (r: ApprovalRequest) => void; timeoutMs?: number } = {},
  ): { requestId: string; decision: Promise<BrokerDecision> } {
    const request: ApprovalRequest = {
      requestId: randomUUID(),
      tool,
      args,
      reason,
      state: "requested",
      createdAt: new Date().toISOString(),
    };
    const decision = new Promise<BrokerDecision>((resolve) => {
      const entry: PendingEntry = { request, resolve };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        entry.timer = setTimeout(() => this.expire(request.requestId), opts.timeoutMs);
        entry.timer.unref?.();
      }
      this.entries.set(request.requestId, entry);
    });
    // Delivery is the broker's job so the state transition stays honest.
    if (opts.onRequest) {
      request.state = "delivered";
      opts.onRequest(request);
    }
    return { requestId: request.requestId, decision };
  }

  /** Gate: resolve a pending request. False when unknown/already decided. */
  decide(requestId: string, decision: BrokerDecision): boolean {
    const entry = this.entries.get(requestId);
    if (!entry || entry.request.state === "decided" || entry.request.state === "expired") return false;
    entry.request.state = "decided";
    entry.request.decision = decision;
    entry.request.decidedAt = new Date().toISOString();
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(decision);
    this.entries.delete(requestId);
    return true;
  }

  /** Requests still awaiting a decision (for a front-end's review queue). */
  pending(): ApprovalRequest[] {
    return [...this.entries.values()].map((e) => e.request);
  }

  private expire(requestId: string): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    entry.request.state = "expired";
    entry.request.decision = "deny";
    entry.request.decidedAt = new Date().toISOString();
    entry.resolve("deny"); // fail-closed
    this.entries.delete(requestId);
  }
}
