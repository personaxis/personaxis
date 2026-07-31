/**
 * Structural drift: the plane that answers why
 * drift only cover numbers, when the spec is full of strings, arrays and booleans?
 */

import { describe, it, expect } from "vitest";
import { structuralDrift, textDistance, listDistance } from "../src/math/structural-drift.js";

const declared = {
  persona: {
    voice: { tone: "terse and precise", register: "professional" },
    constraints: { cannot_claim_real_emotion: true },
  },
  values_and_drives: { values: { safety: { weight: 0.95 } } },
  character: { virtues: ["honesty", "diligence", "courage"] },
  governance: { per_layer_edit_policy: { persona: "governance_controlled", character: "open" } },
};

describe("structural drift (V7.F1)", () => {
  it("reports NOTHING when the live persona still matches its declaration", () => {
    const r = structuralDrift(declared, structuredClone(declared));
    expect(r.changes).toEqual([]);
    expect(r.layers).toEqual([]);
    expect(r.global).toBe(0);
  });

  it("names the exact field that moved, with its before and after", () => {
    const live = structuredClone(declared);
    live.persona.voice.tone = "warm and discursive";
    const r = structuralDrift(declared, live);
    expect(r.changes).toHaveLength(1);
    const c = r.changes[0];
    expect(c.path).toBe("persona.voice.tone");
    expect(c.layer).toBe("persona");
    expect(c.kind).toBe("text");
    expect(c.from).toBe("terse and precise");
    expect(c.to).toBe("warm and discursive");
    expect(c.magnitude).toBeGreaterThan(0.5);
  });

  it("covers EVERY value type, not just numbers", () => {
    const live = structuredClone(declared) as Record<string, never> & typeof declared;
    live.persona.voice.tone = "playful"; // string
    live.persona.constraints.cannot_claim_real_emotion = false; // boolean
    live.values_and_drives.values.safety.weight = 0.5; // number
    live.character.virtues = ["honesty", "curiosity"]; // array
    const r = structuralDrift(declared, live);
    const kinds = new Set(r.changes.map((c) => c.kind));
    expect(kinds).toEqual(new Set(["text", "flag", "number", "list"]));
    expect(r.changes.map((c) => c.path).sort()).toEqual([
      "character.virtues",
      "persona.constraints.cannot_claim_real_emotion",
      "persona.voice.tone",
      "values_and_drives.values.safety.weight",
    ]);
  });

  it("carries the layer's edit policy on every change", () => {
    const live = structuredClone(declared);
    live.persona.voice.tone = "playful";
    live.character.virtues = ["honesty"];
    const r = structuralDrift(declared, live);
    expect(r.changes.find((c) => c.layer === "persona")!.policy).toBe("governance_controlled");
    expect(r.changes.find((c) => c.layer === "character")!.policy).toBe("open");
  });

  it("distinguishes an added field from a removed one", () => {
    const added = structuredClone(declared) as Record<string, unknown>;
    (added.persona as Record<string, unknown>).nickname = "Clio";
    expect(structuralDrift(declared, added).changes[0]).toMatchObject({
      path: "persona.nickname",
      kind: "added",
      magnitude: 1,
    });

    const removed = structuredClone(declared) as { persona: { voice: Record<string, unknown> } };
    delete removed.persona.voice.register;
    expect(structuralDrift(declared, removed).changes[0]).toMatchObject({
      path: "persona.voice.register",
      kind: "removed",
    });
  });

  it("treats a change of SHAPE as a whole-field change, not as key noise", () => {
    const live = structuredClone(declared) as Record<string, unknown>;
    (live.persona as Record<string, unknown>).voice = "terse";
    const r = structuralDrift(declared, live);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ path: "persona.voice", kind: "shape", magnitude: 1 });
  });

  it("summarizes per layer, hottest first, and every magnitude stays in [0,1]", () => {
    const live = structuredClone(declared);
    live.persona.constraints.cannot_claim_real_emotion = false; // magnitude 1
    live.character.virtues = ["honesty", "diligence", "courage", "patience"]; // partial
    const r = structuralDrift(declared, live);
    expect(r.layers[0].layer).toBe("persona");
    expect(r.layers[0].maxMagnitude).toBe(1);
    for (const c of r.changes) {
      expect(c.magnitude).toBeGreaterThan(0);
      expect(c.magnitude).toBeLessThanOrEqual(1);
    }
    expect(r.global).toBeGreaterThan(0);
    expect(r.global).toBeLessThanOrEqual(1);
  });
});

describe("the distance functions are bounded and meaningful", () => {
  it("textDistance: 0 for identical, 1 for disjoint, bounded for long prose", () => {
    expect(textDistance("same", "same")).toBe(0);
    expect(textDistance("", "anything")).toBe(1);
    expect(textDistance("a".repeat(5000), "b".repeat(5000))).toBe(1);
    const small = textDistance("terse and precise", "terse and precise!");
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(0.2); // a one-character edit is a small move
  });

  it("listDistance: membership changes dominate, and REORDERING still registers", () => {
    expect(listDistance(["a", "b"], ["a", "b"])).toBe(0);
    // Order is meaning in this spec (a values list reads as a ranking), so the same
    // members in a different order is a real, if weaker, change.
    expect(listDistance(["a", "b", "c"], ["c", "b", "a"])).toBe(0.25);
    expect(listDistance(["a"], ["b"])).toBe(1);
    expect(listDistance([], [])).toBe(0);
    const partial = listDistance(["a", "b"], ["a", "c"]);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });
});
