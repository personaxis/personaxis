/**
 * Watchdog (K.07): the out-of-band abort. The loop's budget check (`checkAgentBudget`) runs
 * only BETWEEN steps, so a single tool call that hangs, or a step that blows the wall-clock or
 * cost ceiling mid-flight, is not caught until the step returns, which for a hung tool is
 * never. The watchdog runs on a timer independent of the loop: when a limit is breached it
 * aborts immediately, records the abort in the forensic log (module 10), and trips an
 * `AbortSignal`, even while the loop is blocked awaiting a tool.
 *
 * This is the enforcement half of the DoS defense (threat T11): the loop breaker (module 07,
 * `loop-breaker.ts`) stops semantic loops between steps; the watchdog stops a run that exceeds
 * its hard resource envelope regardless of what it is doing.
 *
 * Fires at most once. Never throws into the loop. The clock is injectable so the behavior is
 * tested against a controlled time, not a real wall.
 */

import { ForensicLog } from "./forensic-log.js";

export interface WatchdogLimits {
  maxWallMs?: number;
  maxCostUsd?: number;
  maxTokens?: number;
  /** Out-of-band poll interval; defaults to 1s. */
  pollMs?: number;
}

export interface WatchdogDeps {
  /** Current spend, polled for the cost/token ceilings. */
  spend?: () => { costUsd: number; tokens: number };
  /** Called once, the first time any limit is breached. */
  onAbort: (reason: string) => void;
  /** Where the abort is witnessed. */
  forensic?: ForensicLog;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

export class Watchdog {
  private _aborted = false;
  private _reason: string | null = null;
  private readonly startedAt: number;
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly limits: WatchdogLimits,
    private readonly deps: WatchdogDeps,
  ) {
    this.startedAt = this.clock();
  }

  private clock(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private hasLimits(): boolean {
    return this.limits.maxWallMs != null || this.limits.maxCostUsd != null || this.limits.maxTokens != null;
  }

  /** Evaluate every limit against the current clock/spend; fire on the first breach. */
  check(): void {
    if (this._aborted) return;
    if (this.limits.maxWallMs != null && this.clock() - this.startedAt >= this.limits.maxWallMs) {
      return this.fire(`wall-clock limit ${Math.round(this.limits.maxWallMs / 1000)}s exceeded`);
    }
    if (this.deps.spend && (this.limits.maxCostUsd != null || this.limits.maxTokens != null)) {
      const s = this.deps.spend();
      if (this.limits.maxCostUsd != null && s.costUsd >= this.limits.maxCostUsd) {
        return this.fire(`cost limit $${this.limits.maxCostUsd} exceeded ($${s.costUsd.toFixed(4)})`);
      }
      if (this.limits.maxTokens != null && s.tokens >= this.limits.maxTokens) {
        return this.fire(`token limit ${this.limits.maxTokens} exceeded (${s.tokens})`);
      }
    }
  }

  /** Arm the out-of-band monitor. No-op if no limits are set. */
  start(): void {
    if (this.timer || !this.hasLimits()) return;
    this.timer = setInterval(() => this.check(), this.limits.pollMs ?? 1000);
    this.timer.unref?.();
  }

  /** Disarm. Must be called when the run ends so the timer does not linger. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private fire(reason: string): void {
    if (this._aborted) return;
    this._aborted = true;
    this._reason = reason;
    this.controller.abort();
    this.deps.forensic?.append({ kind: "abort", reason });
    try {
      this.deps.onAbort(reason);
    } catch {
      /* an abort handler that throws must not keep the loop alive */
    }
    this.stop();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get aborted(): boolean {
    return this._aborted;
  }
  get abortReason(): string | null {
    return this._reason;
  }
}
