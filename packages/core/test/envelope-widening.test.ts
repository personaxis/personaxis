/**
 * E23: can a persona widen the ruler it is measured against?
 *
 * The identity axis weighs a coordinate against the envelope the spec declares, and it
 * reads that spec FRESH on every call. Reading fresh is right: the operator edits that
 * file on purpose and the change should take effect. The question this leaves open is
 * what happens when the AGENT is the one editing the declaration, because then the
 * agent widens the range and is afterwards measured against the ruler it just moved.
 *
 * The answer, decided after measuring it: WIDENING IS A STEP AND STEPS HAVE A CEILING.
 * `governance.max_step_delta` already bounds how far a VALUE moves in one step, and had
 * no counterpart for the ruler, so the same ceiling now applies to both rather than a
 * second number being invented for it.
 *
 * Narrowing stays free, and the asymmetry is the design: holding yourself to a tighter
 * range needs no permission, granting yourself more room does, because that is the move
 * that lets a persona approve of itself.
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

  it("a SMALL widening is allowed: a persona may still grow, one step at a time", () => {
    const r = consensusVerify(
      {
        targetPath: "affect.baseline.mood.tone",
        toValue: { mean: 0, range: [-0.3, 0.3] },
        fromValue: { mean: 0, range: [-0.2, 0.2] },
        rationale: "the current range is too narrow for the work I am being asked to do",
      },
      DEFAULT_VERIFIERS,
    );
    expect(r.passed).toBe(true);
  });

  it("a LEAP to the full range is refused, and says by how much it overshot", () => {
    const r = consensusVerify(
      {
        targetPath: "affect.baseline.mood.tone",
        toValue: { mean: 0, range: [-1, 1] },
        fromValue: { mean: 0, range: [-0.2, 0.2] },
        rationale: "the current range is too narrow for the work I am being asked to do",
      },
      DEFAULT_VERIFIERS,
    );
    expect(r.passed).toBe(false);
    expect(r.results.find((x) => x.verifier === "envelope-step")?.reason).toMatch(/against a 0.15 ceiling/);
  });

  it("NARROWING is free, however far: holding yourself tighter needs no permission", () => {
    const r = consensusVerify(
      {
        targetPath: "affect.baseline.mood.tone",
        toValue: { mean: 0, range: [-0.05, 0.05] },
        fromValue: { mean: 0, range: [-1, 1] },
        rationale: "I keep overshooting and would rather hold a tighter range for now",
      },
      DEFAULT_VERIFIERS,
    );
    expect(r.passed).toBe(true);
  });

  it("the ceiling is PER SIDE, so pushing both edges out is not a way around it", () => {
    // Each edge moves 0.1, under the 0.15 ceiling, while the room doubles. Measured on
    // the width this would pass, which is why it is measured per side.
    const r = consensusVerify(
      {
        targetPath: "affect.baseline.mood.tone",
        toValue: { mean: 0, range: [-0.3, 0.3] },
        fromValue: { mean: 0, range: [-0.2, 0.2] },
        rationale: "a little more room on both sides of the range, for the same reason",
      },
      DEFAULT_VERIFIERS,
    );
    // 0.1 a side is within the step, so this one stands: the point is that the check
    // reads each edge, and the next test is the one that could only pass on width.
    expect(r.passed).toBe(true);

    const both = consensusVerify(
      {
        targetPath: "affect.baseline.mood.tone",
        toValue: { mean: 0, range: [-0.4, 0.4] },
        fromValue: { mean: 0, range: [-0.2, 0.2] },
        rationale: "a lot more room on both sides of the range, for the same reason",
      },
      DEFAULT_VERIFIERS,
    );
    expect(both.passed).toBe(false);
  });

  it("the sanity checks still stand: a malformed range is refused before any of this", () => {
    for (const range of [[1, -1], [-4, 4]]) {
      const r = consensusVerify(
        {
          targetPath: "affect.baseline.mood.tone",
          toValue: { mean: 0, range },
          fromValue: { mean: 0, range: [-0.2, 0.2] },
          rationale: "a rationale long enough to clear its own verifier",
        },
        DEFAULT_VERIFIERS,
      );
      expect(r.passed).toBe(false);
    }
  });

  it("an envelope edit that never read its predecessor is refused, not waved through", () => {
    // Absent key, not undefined value: nobody looked. A verifier that needs the old
    // value and silently passes without it is a guard that reads as covered and refuses
    // nothing, which is the failure this whole row exists to avoid.
    const r = consensusVerify(
      {
        targetPath: "affect.baseline.mood.tone",
        toValue: { mean: 0, range: [-0.25, 0.25] },
        rationale: "a rationale long enough to clear its own verifier",
      },
      DEFAULT_VERIFIERS,
    );
    expect(r.passed).toBe(false);
  });
});
