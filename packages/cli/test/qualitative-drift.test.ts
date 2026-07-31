import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { proposeSelfEdit } from "@personaxis/core";
import { qualitativeReport } from "../src/repl/views/drift-data.js";
import { saveManifest, hashContent } from "../src/manifest.js";
import { writeStarterPersona } from "../src/starter.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-qdrift-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("qualitativeReport (V5.P2.1: the non-numeric drift plane)", () => {
  it("is empty on a fresh persona whose spec matches its manifest", () => {
    const p = writeStarterPersona(dir, "Qa");
    saveManifest(dirname(p), { personaxisMdHash: hashContent(readFileSync(p, "utf-8")) } as never);
    const r = qualitativeReport(p);
    expect(r.layers).toEqual([]);
    expect(r.totalApplied + r.totalPending).toBe(0);
    expect(r.specChangedSinceCompile).toBe(false);
  });

  it("buckets governed self-edits per layer with applied/pending counts", () => {
    const p = writeStarterPersona(dir, "Qb");
    // suggesting mode queues (starter persona defaults to suggesting or locked; force via mode arg)
    proposeSelfEdit(
      p,
      { targetPath: "persona.voice.tone", toValue: "warmer", rationale: "test", sources: ["user"] } as never,
      "suggesting",
    );
    const r = qualitativeReport(p);
    const persona = r.layers.find((l) => l.layer === "persona");
    expect(persona).toBeDefined();
    expect((persona!.applied + persona!.pending) >= 1).toBe(true);
  });

  it("flags a spec text change against the manifest hash", () => {
    const p = writeStarterPersona(dir, "Qc");
    saveManifest(dirname(p), { personaxisMdHash: hashContent(readFileSync(p, "utf-8")) } as never);
    writeFileSync(p, readFileSync(p, "utf-8") + "\n<!-- touched -->\n");
    const r = qualitativeReport(p);
    expect(r.specChangedSinceCompile).toBe(true);
  });
});
