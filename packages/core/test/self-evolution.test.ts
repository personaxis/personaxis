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
  isProtected,
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

describe("autonomous flow (sandbox)", () => {
  it("auto-applies within guards and overlays the value", () => {
    const r = proposeSelfEdit(personaPath, req("personality.traits.conscientiousness"), "autonomous");
    expect(r.status).toBe("applied");
    expect(activeOverlay(personaPath)["personality.traits.conscientiousness"]).toBeDefined();
  });
});
