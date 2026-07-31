/**
 * Loop breaker (J.4): stop the agent from hammering a failing action or spinning without
 * progress. This is the classic autonomous-agent failure and a real DoS vector (a tool that
 * induces repetition burns the whole token/cost budget for nothing, threat T11).
 *
 * Escalation, not a hair-trigger: the first time a repetition or a stall crosses the limit we
 * NUDGE (inject one hint telling the model to change approach); only if it persists one more
 * step do we STOP. So a model that self-corrects after the hint is never cut off, and one that
 * ignores it cannot loop forever. Healthy runs (which make progress) never see either.
 *
 * Pure and stateful-by-construction: `record` appends a step outcome, `assess` reads the
 * trailing run. No LLM, fully unit-tested; the agent loop owns the wiring.
 */

/** What one loop step produced, from the breaker's point of view. */
export interface StepOutcome {
  /** True if at least one tool call in the step succeeded (real forward progress). */
  producedWork: boolean;
  /** Signature of a failing call, to detect exact repetition. Null when work was produced. */
  failingSignature: string | null;
}

export interface LoopBreakerConfig {
  /** Consecutive identical failing steps before we act. */
  repeatLimit: number;
  /** Consecutive no-progress steps before we act. */
  stallLimit: number;
}

/**
 * Conservative on purpose: a healthy task completes in a handful of steps and never repeats
 * the SAME failing call, so these thresholds do not fire on normal runs.
 */
export const DEFAULT_LOOP_BREAKER: LoopBreakerConfig = { repeatLimit: 3, stallLimit: 5 };

export type BreakerVerdict =
  | { action: "continue" }
  | { action: "nudge"; reason: string }
  | { action: "stop"; reason: string };

/** A stable, order-independent signature for a tool call, so `{a,b}` == `{b,a}`. */
export function toolSignature(name: string, args: Record<string, unknown>): string {
  const stable = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join(",");
  return `${name}(${stable})`;
}

export class LoopBreaker {
  private readonly steps: StepOutcome[] = [];

  constructor(private readonly config: LoopBreakerConfig = DEFAULT_LOOP_BREAKER) {}

  record(outcome: StepOutcome): void {
    this.steps.push(outcome);
  }

  /** Assess the trailing run after the latest step was recorded. */
  assess(): BreakerVerdict {
    const { repeatLimit, stallLimit } = this.config;
    const n = this.steps.length;
    if (n === 0) return { action: "continue" };
    const last = this.steps[n - 1]!;

    // Repetition of the SAME failing action: the more specific signal, checked first.
    if (last.failingSignature) {
      let run = 0;
      for (let i = n - 1; i >= 0 && this.steps[i]!.failingSignature === last.failingSignature; i--) run++;
      if (run >= repeatLimit + 1) {
        return { action: "stop", reason: `repeated the same failing action ${run}x (${last.failingSignature})` };
      }
      if (run === repeatLimit) {
        return { action: "nudge", reason: `tried ${last.failingSignature} ${run}x without success; change approach` };
      }
    }

    // Stall: no forward progress for a stretch, even if the calls vary.
    let stall = 0;
    for (let i = n - 1; i >= 0 && !this.steps[i]!.producedWork; i--) stall++;
    if (stall >= stallLimit + 1) return { action: "stop", reason: `no progress in ${stall} steps` };
    if (stall === stallLimit) return { action: "nudge", reason: `no progress in ${stall} steps; try a different strategy` };

    return { action: "continue" };
  }
}
