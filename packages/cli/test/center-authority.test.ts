/**
 * V9 / G.3: action authority is the engine's, not a reinvention. A numeric coordinate is
 * editable unless a hard virtue protects it; a qualitative target is resolved by `editGate`,
 * so the safety floor blocks identity/character under ANY mode, and a governed layer follows
 * the mode (locked → blocked, suggesting → proposal, autonomous → direct).
 */
import { describe, it, expect } from "vitest";
import { numericFieldEffect, qualitativeEffect, CANONICAL_LAYERS } from "../src/center/authority.js";

describe("action authority (G.3)", () => {
  it("numeric coordinate: protected → blocked, else clamped direct", () => {
    const key = "personality.traits.honesty_humility";
    expect(numericFieldEffect(key, [key]).effect).toBe("blocked");
    expect(numericFieldEffect(key, [key]).reason).toMatch(/protected/);
    expect(numericFieldEffect("personality.traits.openness", []).effect).toBe("direct");
  });

  it("the safety floor blocks identity/character regardless of mode", () => {
    for (const mode of ["locked", "suggesting", "autonomous"] as const) {
      expect(qualitativeEffect("identity", {}, mode).effect).toBe("blocked");
      expect(qualitativeEffect("character.virtues", {}, mode).effect).toBe("blocked");
      expect(qualitativeEffect("identity", {}, mode).reason).toMatch(/safety floor/);
    }
  });

  it("a governed (default) layer follows the mode", () => {
    // No declared per_layer_edit_policy → governance_controlled → follows the mode.
    expect(qualitativeEffect("personality", {}, "locked").effect).toBe("blocked");
    expect(qualitativeEffect("personality", {}, "suggesting").effect).toBe("proposal");
    expect(qualitativeEffect("personality", {}, "autonomous").effect).toBe("direct");
  });

  it("an author-declared per-layer policy overrides the mode", () => {
    // `review_required` forces a proposal even under autonomous.
    const fm = { governance: { per_layer_edit_policy: { personality: "review_required" } } };
    expect(qualitativeEffect("personality", fm, "autonomous").effect).toBe("proposal");
    // `locked` layer policy blocks even under autonomous.
    const locked = { governance: { per_layer_edit_policy: { memory: "locked" } } };
    expect(qualitativeEffect("memory", locked, "autonomous").effect).toBe("blocked");
  });

  it("covers all 10 canonical layers", () => {
    expect(CANONICAL_LAYERS).toHaveLength(10);
    for (const layer of CANONICAL_LAYERS) {
      expect(["direct", "proposal", "blocked"]).toContain(qualitativeEffect(layer, {}, "suggesting").effect);
    }
  });
});
