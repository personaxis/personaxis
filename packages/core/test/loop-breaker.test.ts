/**
 * J.4: the loop breaker escalates (nudge, then stop) on repetition or stall, and stays silent
 * on a healthy run. These are the three behaviors that matter; one test each.
 */
import { describe, it, expect } from "vitest";
import { LoopBreaker, toolSignature, type StepOutcome } from "../src/loop-breaker.js";

const work: StepOutcome = { producedWork: true, failingSignature: null };
const failing = (sig: string): StepOutcome => ({ producedWork: false, failingSignature: sig });

function run(outcomes: StepOutcome[]): string[] {
  const b = new LoopBreaker({ repeatLimit: 3, stallLimit: 5 });
  return outcomes.map((o) => {
    b.record(o);
    return b.assess().action;
  });
}

describe("loop breaker (J.4)", () => {
  it("never fires while the agent makes progress", () => {
    expect(run([work, work, work, work, work, work])).toEqual(Array(6).fill("continue"));
  });

  it("nudges at the repeat limit, then stops if the SAME failing call persists", () => {
    const sig = toolSignature("run_command", { command: "make" });
    // 3 identical failures → nudge on the 3rd; a 4th → stop.
    const verdicts = run([failing(sig), failing(sig), failing(sig), failing(sig)]);
    expect(verdicts).toEqual(["continue", "continue", "nudge", "stop"]);
  });

  it("resets when the model changes approach after the nudge", () => {
    const a = toolSignature("run_command", { command: "make" });
    const b = toolSignature("read_file", { path: "log" });
    // fail a,a,a (nudge), then a DIFFERENT failing call breaks the run.
    const verdicts = run([failing(a), failing(a), failing(a), failing(b)]);
    expect(verdicts.slice(0, 3)).toEqual(["continue", "continue", "nudge"]);
    // The new signature's run is 1, so no repeat-stop; stall is only 4 (< 6), so continue.
    expect(verdicts[3]).toBe("continue");
  });

  it("nudges then stops on a stall of varied failing calls (no exact repetition)", () => {
    // Each step fails with a different signature: no repetition, but no progress either.
    const varied = Array.from({ length: 6 }, (_, i) => failing(`t${i}(x)`));
    const verdicts = run(varied);
    expect(verdicts[4]).toBe("nudge"); // stallLimit = 5 → 5th no-progress step
    expect(verdicts[5]).toBe("stop"); // 6th
  });

  it("signature is order-independent", () => {
    expect(toolSignature("t", { a: 1, b: 2 })).toBe(toolSignature("t", { b: 2, a: 1 }));
  });
});
