/**
 * F3.7, surgical, comment-preserving dot-path edits.
 */
import { describe, it, expect } from "vitest";
import { getAtPath, coerceLike, setScalarAtPath } from "../src/index.js";

const YAML = `metadata:
  name: cmo            # the persona id
  version: "2.0.0"
identity:
  short_name: Mira
improvement_policy:
  mode: suggesting     # propose self-edits
character:
  virtues:
    honesty:
      enforcement: hard
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-1, 1] }   # flow-map envelope
flag: true`;

function parsed(): Record<string, unknown> {
  // A tiny YAML-ish parse is unnecessary, hand-build the object the edit reads for type/current.
  return {
    metadata: { name: "cmo", version: "2.0.0" },
    identity: { short_name: "Mira" },
    improvement_policy: { mode: "suggesting" },
    character: { virtues: { honesty: { enforcement: "hard" } } },
    affect: { baseline: { mood: { tone: { mean: 0.0, range: [-1, 1] } } } },
    flag: true,
  };
}

describe("F3.7 getAtPath + coerceLike", () => {
  it("reads nested dot-paths", () => {
    expect(getAtPath(parsed(), "improvement_policy.mode")).toBe("suggesting");
    expect(getAtPath(parsed(), "character.virtues.honesty.enforcement")).toBe("hard");
    expect(getAtPath(parsed(), "nope.missing")).toBeUndefined();
  });
  it("coerces to the current value's type", () => {
    expect(coerceLike("autonomous", "suggesting")).toBe("autonomous");
    expect(coerceLike("0.5", 0.0)).toBe(0.5);
    expect(coerceLike("false", true)).toBe(false);
    expect(() => coerceLike("x", 0)).toThrow(/not a number/);
    expect(() => coerceLike("x", true)).toThrow(/not a boolean/);
  });
});

describe("F3.7 setScalarAtPath, comment-preserving textual set", () => {
  it("edits a nested block scalar and keeps the trailing comment", () => {
    const r = setScalarAtPath(YAML, parsed(), "improvement_policy.mode", "autonomous");
    expect(r.previous).toBe("suggesting");
    expect(r.text).toContain("mode: autonomous     # propose self-edits");
    // nothing else changed
    expect(r.text).toContain("short_name: Mira");
    expect(r.text).toContain("enforcement: hard");
  });

  it("edits a deep block scalar", () => {
    const r = setScalarAtPath(YAML, parsed(), "character.virtues.honesty.enforcement", "soft");
    expect(r.text).toContain("enforcement: soft");
  });

  it("edits a one-level flow-map leaf, preserving the rest of the map + comment", () => {
    const r = setScalarAtPath(YAML, parsed(), "affect.baseline.mood.tone.mean", 0.25);
    expect(r.previous).toBe(0.0);
    expect(r.text).toContain("tone: { mean: 0.25, range: [-1, 1] }   # flow-map envelope");
  });

  it("quotes a string value that would be misread as another YAML type", () => {
    const r = setScalarAtPath(YAML, parsed(), "identity.short_name", "true");
    expect(r.text).toContain('short_name: "true"');
  });

  it("edits a top-level scalar", () => {
    const r = setScalarAtPath(YAML, parsed(), "flag", false);
    expect(r.text.trimEnd().endsWith("flag: false")).toBe(true);
  });

  it("rejects a non-scalar (block) path", () => {
    expect(() => setScalarAtPath(YAML, parsed(), "improvement_policy", "x")).toThrow(/block/);
    expect(() => setScalarAtPath(YAML, parsed(), "character.virtues", "x")).toThrow(/block/);
  });

  it("rejects a missing path", () => {
    expect(() => setScalarAtPath(YAML, parsed(), "identity.nope", "x")).toThrow(/not found/);
  });
});
