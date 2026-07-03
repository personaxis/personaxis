import { describe, expect, it } from "vitest";
import { governMutations } from "../src/governance.js";
import type { EnvelopeLookup } from "../src/envelopes.js";

const env: EnvelopeLookup = {
  envelopes: {
    "mood.tone": { mean: 0, min: -1, max: 1 },
    "traits.honesty_humility": { mean: 0.9, min: 0.8, max: 1 },
  },
  hardEnforcedVirtues: ["honesty_humility"],
};

describe("governance gate — human-directed vs autonomous (F1.3)", () => {
  it("locked mode rejects a non-human mutation", () => {
    const d = governMutations(
      [{ field: "mood.tone", delta: 0.1, reason: "llm nudge" }],
      env,
      { mode: "locked", maxStepDelta: 0.15 },
    );
    expect(d.admitted).toHaveLength(0);
    expect(d.rejected[0].reason).toContain("locked");
  });

  it("locked mode ADMITS a human-directed mutation (CLI state mutate)", () => {
    const d = governMutations(
      [{ field: "mood.tone", delta: 0.1, reason: "operator adjust" }],
      env,
      { mode: "locked", maxStepDelta: 0.15, humanDirected: true },
    );
    expect(d.admitted).toHaveLength(1);
    expect(d.admitted[0].delta).toBe(0.1);
  });

  it("hard-enforced virtue trait is immutable for EVERY actor, human included", () => {
    const d = governMutations(
      [{ field: "traits.honesty_humility", delta: -0.05, reason: "attempt" }],
      env,
      { mode: "autonomous", maxStepDelta: 0.15, humanDirected: true },
    );
    expect(d.admitted).toHaveLength(0);
    expect(d.rejected[0].reason).toContain("hard-enforced virtue");
  });

  it("max_step_delta bounds non-human deltas but not human-directed ones", () => {
    const auto = governMutations(
      [{ field: "mood.tone", delta: 0.9, reason: "big llm nudge" }],
      env,
      { mode: "suggesting", maxStepDelta: 0.15 },
    );
    expect(auto.admitted[0].delta).toBe(0.15);
    expect(auto.admitted[0].reason).toContain("drift-bounded");

    const human = governMutations(
      [{ field: "mood.tone", delta: 0.9, reason: "operator adjust" }],
      env,
      { mode: "suggesting", maxStepDelta: 0.15, humanDirected: true },
    );
    expect(human.admitted[0].delta).toBe(0.9); // envelope clamp still applies downstream
  });

  it("unknown fields are rejected for everyone", () => {
    const d = governMutations(
      [{ field: "identity.purpose", delta: 0.1, reason: "nope" }],
      env,
      { mode: "autonomous", maxStepDelta: 0.15, humanDirected: true },
    );
    expect(d.admitted).toHaveLength(0);
    expect(d.rejected[0].reason).toContain("not a mutable envelope field");
  });
});
