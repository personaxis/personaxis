/**
 * E23: can a persona widen the ruler it is measured against?
 *
 * The identity axis weighs a coordinate against the envelope the spec declares, and it
 * reads that spec FRESH on every call. Reading fresh is right: the operator edits that
 * file on purpose and the change should take effect. The question this leaves open is
 * what happens when the AGENT is the one editing the declaration, because then the
 * agent widens the range and is afterwards measured against the ruler it just moved.
 *
 * These tests do not answer that question, which is a product decision. They MEASURE
 * whether it is reachable today, so the decision is taken against facts.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_VERIFIERS, consensusVerify, isProtectedPath, type Policy } from "../src/index.js";

const policy = (root: string): Policy => ({
  sandbox: "danger-full-access",
  approval: "never",
  allow: [".*"],
  deny: [],
  workspaceRoot: root,
});

describe("what stops a persona from moving its own ruler (E23)", () => {
  it("the DIRECT route is shut: no file tool may write into .personaxis", () => {
    // And not by the allow-list's leave: the anti-escalation guard runs first.
    const p = policy("/work");
    expect(isProtectedPath("/work/.personaxis/personaxis.md", p)).toBe(true);
    expect(isProtectedPath(".personaxis/personaxis.md", p)).toBe(true);
    expect(isProtectedPath("/work/src/index.ts", p)).toBe(false);
  });

  it("the SANCTIONED route protects identity, limits and permissions", () => {
    for (const path of [
      "identity.canonical_id",
      "character.virtues",
      "self_regulation.hard_limits",
      "governance.max_step_delta",
      "permissions",
    ]) {
      const r = consensusVerify({ targetPath: path, toValue: 1, rationale: "because" }, DEFAULT_VERIFIERS);
      expect(r.passed, `${path} must stay protected`).toBe(false);
    }
  });

  it("BUT an affect envelope can be widened, and the verifiers call it sane", () => {
    // This is the measurement the row asked for. `affect.representation` and
    // `affect.regulation_policy` are protected; the BASELINE envelopes are not, and the
    // envelope verifier checks that a range is well formed, never that it grew.
    const widened = consensusVerify(
      {
        targetPath: "affect.baseline.mood.tone",
        toValue: { mean: 0, range: [-1, 1] },
        rationale: "I want more room to express myself across the full range",
      },
      DEFAULT_VERIFIERS,
    );
    expect(widened.passed).toBe(true);

    // The verifier is not asleep: it refuses a range that makes no sense. What it has
    // no opinion about is a range that makes sense and is bigger than yesterday's.
    const nonsense = consensusVerify(
      { targetPath: "affect.baseline.mood.tone", toValue: { mean: 0, range: [1, -1] }, rationale: "why not" },
      DEFAULT_VERIFIERS,
    );
    expect(nonsense.passed).toBe(false);

    const outOfBounds = consensusVerify(
      { targetPath: "affect.baseline.mood.tone", toValue: { mean: 0, range: [-4, 4] }, rationale: "why not" },
      DEFAULT_VERIFIERS,
    );
    expect(outOfBounds.passed).toBe(false);
  });

  it("nothing in the verifiers can even see the PREVIOUS range", () => {
    // Which is why this cannot be fixed by tightening a verifier: they are handed a
    // proposal, not a diff. Whatever the answer to E23 turns out to be, it needs the
    // old value, and today that never reaches this decision.
    // The rationale is a real one: a short one is refused by its own verifier, which
    // is a different rule and would have made this test pass for the wrong reason.
    const proposal = {
      targetPath: "affect.baseline.mood.tone",
      toValue: { mean: 0, range: [-1, 1] },
      rationale: "the current range is too narrow for the work I am being asked to do",
    };
    expect(Object.keys(proposal)).not.toContain("fromValue");
    expect(consensusVerify(proposal, DEFAULT_VERIFIERS).passed).toBe(true);
  });
});
