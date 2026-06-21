import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sensitiveActionGate,
  detectMemoryAnomalies,
  prepareMemoryEntry,
  commitMemoryEntry,
  tombstoneMemory,
  readMemory,
  readLiveMemory,
  verifyMemoryChain,
} from "../src/index.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-sec-"));
  personaPath = join(dir, "personaxis.md");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sensitive-action gate (provenance)", () => {
  it("blocks deletion justified only by untrusted (tool) provenance", () => {
    const r = sensitiveActionGate("delete", ["tool"]);
    expect(r.allowed).toBe(false);
  });
  it("allows deletion justified by the user", () => {
    const r = sensitiveActionGate("delete", ["user"]);
    expect(r.allowed).toBe(true);
  });
  it("weakest link caps trust", () => {
    const r = sensitiveActionGate("external_api", ["user", "tool"]);
    // external_api needs trust>=2; tool=1 caps it
    expect(r.allowed).toBe(false);
  });
});

describe("memory anomaly detection", () => {
  it("flags an untrusted-write spike", () => {
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "a", source: "tool" }));
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "b", source: "tool" }));
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "c", source: "synthesis" }));
    const anomalies = detectMemoryAnomalies(readMemory(personaPath));
    expect(anomalies.some((a) => a.kind === "untrusted-spike")).toBe(true);
  });
  it("flags a contradiction", () => {
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "the deploy is safe", source: "user" }));
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "actually no deploy is safe here", source: "tool" }));
    const anomalies = detectMemoryAnomalies(readMemory(personaPath));
    expect(anomalies.some((a) => a.kind === "contradiction")).toBe(true);
  });
});

describe("user-requested deletion (tombstone)", () => {
  it("hides a tombstoned entry from live reads but keeps the chain intact", () => {
    const e1 = prepareMemoryEntry(personaPath, { content: "secret", source: "user" });
    commitMemoryEntry(personaPath, e1);
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "keep", source: "user" }));
    tombstoneMemory(personaPath, e1.hash, "user asked");
    const live = readLiveMemory(personaPath);
    expect(live.map((e) => e.content)).toEqual(["keep"]);
    expect(verifyMemoryChain(personaPath).ok).toBe(true); // append-only chain preserved
  });
});
