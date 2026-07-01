import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Persona } from "../src/index.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-sdk-"));
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  personaPath = join(dir, ".personaxis", "personaxis.md");
  writeFileSync(
    personaPath,
    `---
apiVersion: persona.dev/v1
metadata: { name: sdk, version: 1.0.0 }
identity: { canonical_id: sdk, display_name: Sdk }
memory: { types: { episodic: true } }
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-1, 1] }
---
You are Sdk, a support persona.
`,
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("@personaxis/sdk — Persona embed API", () => {
  it("exposes the compiled identity (falls back to the spec body)", () => {
    const p = new Persona(personaPath);
    expect(p.compiledIdentity()).toContain("You are Sdk");
  });

  it("reads runtime state seeded from the envelope means", () => {
    const p = new Persona(personaPath);
    const st = p.state();
    expect(st.values["mood.tone"]).toBe(0);
    expect(Array.isArray(st.recentMutations)).toBe(true);
  });

  it("applies a clamped, audited mutation", () => {
    const p = new Persona(personaPath);
    const r = p.adjust("mood.tone", -0.1, "customer frustrated");
    expect(r.to).toBeCloseTo(-0.1);
    expect(p.audit().mutationCount).toBe(1);
  });

  it("observe runs a governed tick offline (heuristic) without throwing", async () => {
    const p = new Persona(personaPath);
    const r = await p.observe("the customer prefers email over phone", "user");
    expect(r.report).toBeTruthy();
    expect(typeof r.recompilePending).toBe("boolean");
  });

  it("audit reports an intact memory chain", () => {
    const p = new Persona(personaPath);
    expect(p.audit().memoryChainIntact).toBe(true);
  });
});
