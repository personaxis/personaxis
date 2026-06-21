import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  proposeSelfEdit,
  applySelfEdit,
  revertSelfEdit,
  rejectSelfEdit,
  proposals,
  activeOverlay,
  applyOverlay,
  extractEnvelopes,
  isProtected,
  consensusVerify,
  SelfEditError,
} from "../src/index.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-se-"));
  personaPath = join(dir, "personaxis.md");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const req = (targetPath: string) => ({
  targetPath,
  toValue: { mean: 0.7, range: [0.6, 0.8] },
  rationale: "observed pattern",
  sources: ["user" as const],
});

describe("self-evolution guards", () => {
  it("protects identity/character/safety/universals", () => {
    expect(isProtected("identity.display_name")).toBe(true);
    expect(isProtected("character.virtues.honesty.enforcement")).toBe(true);
    expect(isProtected("affect.representation")).toBe(true);
    expect(isProtected("persona.constraints.cannot_claim_real_emotion")).toBe(true);
    expect(isProtected("personality.traits.openness")).toBe(false);
  });

  it("rejects a protected-path proposal", () => {
    expect(() => proposeSelfEdit(personaPath, req("identity.display_name"), "autonomous")).toThrow(
      SelfEditError,
    );
  });

  it("forbids proposals in locked mode", () => {
    expect(() => proposeSelfEdit(personaPath, req("personality.traits.openness"), "locked")).toThrow(
      /locked/,
    );
  });

  it("refuses untrusted provenance", () => {
    expect(() =>
      proposeSelfEdit(
        personaPath,
        { ...req("personality.traits.openness"), sources: ["tool"] },
        "suggesting",
      ),
    ).toThrow(/refused/);
  });
});

describe("suggesting flow (human approval)", () => {
  it("queues pending, then applies + mints a version, then reverts", () => {
    const { id, status } = proposeSelfEdit(personaPath, req("personality.traits.openness"), "suggesting");
    expect(status).toBe("pending");

    const applied = applySelfEdit(personaPath, id, "human-operator");
    expect(applied.status).toBe("applied");
    expect(applied.version).toBe("0.0.1");
    expect(activeOverlay(personaPath)["personality.traits.openness"]).toEqual({ mean: 0.7, range: [0.6, 0.8] });

    revertSelfEdit(personaPath, id, "human-operator");
    expect(proposals(personaPath).find((p) => p.id === id)!.status).toBe("reverted");
    expect(activeOverlay(personaPath)["personality.traits.openness"]).toBeUndefined();
  });

  it("can reject a pending proposal", () => {
    const { id } = proposeSelfEdit(personaPath, req("personality.traits.openness"), "suggesting");
    rejectSelfEdit(personaPath, id, "human-operator");
    expect(proposals(personaPath).find((p) => p.id === id)!.status).toBe("rejected");
  });
});

describe("multi-agent consensus before apply", () => {
  it("passes a clean envelope edit unanimously", () => {
    const r = consensusVerify({
      targetPath: "personality.traits.openness",
      toValue: { mean: 0.5, range: [0.4, 0.6] },
      rationale: "good reason here",
    });
    expect(r.passed).toBe(true);
    expect(r.passes).toBe(r.quorum);
  });

  it("blocks an insane envelope edit (min >= max) and records a rejection", () => {
    const { id } = proposeSelfEdit(
      personaPath,
      { targetPath: "personality.traits.openness", toValue: { mean: 0.7, range: [0.8, 0.6] }, rationale: "bad range here", sources: ["user"] },
      "suggesting",
    );
    expect(() => applySelfEdit(personaPath, id, "human-operator")).toThrow(/consensus failed/);
    expect(proposals(personaPath).find((p) => p.id === id)!.status).toBe("rejected");
  });

  it("blocks an edit with too-short rationale", () => {
    const { id } = proposeSelfEdit(
      personaPath,
      { targetPath: "personality.traits.openness", toValue: { mean: 0.5, range: [0.4, 0.6] }, rationale: "ok", sources: ["user"] },
      "suggesting",
    );
    expect(() => applySelfEdit(personaPath, id, "human-operator")).toThrow(/consensus/);
  });

  it("autonomous apply also goes through consensus (throws on bad range)", () => {
    expect(() =>
      proposeSelfEdit(
        personaPath,
        { targetPath: "personality.traits.openness", toValue: { mean: 0.7, range: [0.9, 0.1] }, rationale: "reasoned enough", sources: ["user"] },
        "autonomous",
      ),
    ).toThrow(/consensus/);
  });
});

describe("applied self-edits actually take effect (overlay)", () => {
  it("applyOverlay deep-sets a dot path without mutating the original", () => {
    const fm = { personality: { traits: { openness: { mean: 0.5, range: [0.4, 0.6] } } } };
    const out = applyOverlay(fm, { "personality.traits.openness": { mean: 0.7, range: [0.6, 0.8] } });
    expect((out as typeof fm).personality.traits.openness.range).toEqual([0.6, 0.8]);
    // original untouched
    expect(fm.personality.traits.openness.range).toEqual([0.4, 0.6]);
  });

  it("an applied edit changes the extracted envelope used for clamping", () => {
    const fm = { personality: { traits: { openness: { mean: 0.5, range: [0.4, 0.6] } } } };
    proposeSelfEdit(personaPath, req("personality.traits.openness"), "autonomous"); // toValue range [0.6,0.8]
    const overlaid = applyOverlay(fm, activeOverlay(personaPath));
    const env = extractEnvelopes(overlaid);
    expect(env.envelopes["traits.openness"]).toEqual({ mean: 0.7, min: 0.6, max: 0.8 });
  });
});

describe("autonomous flow (sandbox)", () => {
  it("auto-applies within guards and overlays the value", () => {
    const r = proposeSelfEdit(personaPath, req("personality.traits.conscientiousness"), "autonomous");
    expect(r.status).toBe("applied");
    expect(activeOverlay(personaPath)["personality.traits.conscientiousness"]).toBeDefined();
  });
});
