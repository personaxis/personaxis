/**
 * v1.0 memory erasure (D6): the chain hash commits to content_hash, so content
 * can be REDACTED (right-to-erasure) while the chain stays verifiable, the
 * resolution of the GDPR-vs-append-only conflict. Legacy (≤0.10) logs hash over
 * the content itself and must be re-anchored (migrateMemoryChain) first.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  prepareMemoryEntry,
  commitMemoryEntry,
  verifyMemoryChain,
  readMemory,
  readLiveMemory,
  redactMemory,
  migrateMemoryChain,
  tombstoneMemory,
  type MemoryEntry,
} from "../src/index.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-erase-"));
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  personaPath = join(dir, ".personaxis", "personaxis.md");
  writeFileSync(personaPath, "---\nmetadata: { name: e }\n---\nbody\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(content: string): MemoryEntry {
  const e = prepareMemoryEntry(personaPath, { content, source: "user" });
  commitMemoryEntry(personaPath, e);
  return e;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Write a LEGACY-format entry (hash over content, no content_hash). */
function writeLegacy(content: string, prev: string): MemoryEntry {
  const base = { ts: new Date().toISOString(), content, source: "user" as const, tags: [], prev_hash: prev };
  const hash = sha256(JSON.stringify({ ts: base.ts, content, source: "user", tags: [], prev_hash: prev }));
  const entry = { ...base, hash };
  const p = join(dirname(personaPath), "memory", "episodic.jsonl");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, readFileSyncSafe(p) + JSON.stringify(entry) + "\n", "utf-8");
  return entry;
}
function readFileSyncSafe(p: string): string {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

describe("v1.0 erasure-capable memory chain", () => {
  it("new entries are content_hash-anchored and verify", () => {
    const e = write("the customer prefers email");
    expect(e.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.content_hash).toBe(sha256("the customer prefers email"));
    expect(verifyMemoryChain(personaPath).ok).toBe(true);
  });

  it("redaction erases the content but the chain STAYS verifiable", () => {
    write("keep me");
    const target = write("PII: alice@example.com lives at 4 Elm St");
    write("keep me too");

    const { redacted, audit } = redactMemory(personaPath, target.hash, "user erasure request");
    expect(redacted.content).toBe("[redacted]");
    expect(redacted.redacted).toBe(true);
    expect(redacted.content_hash).toBe(target.content_hash); // retained for the chain

    // The bytes are GONE from disk (real erasure, not tombstone-hiding).
    const raw = readFileSync(join(dirname(personaPath), "memory", "episodic.jsonl"), "utf-8");
    expect(raw).not.toContain("alice@example.com");

    // Chain intact end-to-end, including entries AFTER the redacted one.
    expect(verifyMemoryChain(personaPath).ok).toBe(true);

    // The erasure is itself audited and the entry leaves live retrieval.
    expect(audit.tags).toContain("tombstone");
    expect(readLiveMemory(personaPath).some((e) => e.hash === target.hash)).toBe(false);
  });

  it("tampering with a NON-redacted entry's content still breaks the chain", () => {
    const e = write("original");
    const p = join(dirname(personaPath), "memory", "episodic.jsonl");
    const lines = readFileSync(p, "utf-8").trim().split("\n");
    const parsed = JSON.parse(lines[0]) as MemoryEntry;
    parsed.content = "poisoned";
    writeFileSync(p, JSON.stringify(parsed) + "\n", "utf-8");
    expect(verifyMemoryChain(personaPath).ok).toBe(false);
    expect(e.hash).toBe(parsed.hash); // hash untouched, content check catches it
  });

  it("refuses to redact a legacy entry and migrateMemoryChain re-anchors it", () => {
    const legacy = writeLegacy("old-format secret", "");
    expect(verifyMemoryChain(personaPath).ok).toBe(true); // dual verify accepts legacy
    expect(() => redactMemory(personaPath, legacy.hash, "erase")).toThrow(/legacy format/);

    const { migrated, remapped } = migrateMemoryChain(personaPath);
    expect(migrated).toBe(1);
    const newHash = remapped[legacy.hash];
    expect(newHash).toBeTruthy();
    expect(verifyMemoryChain(personaPath).ok).toBe(true);

    // Now redactable.
    redactMemory(personaPath, newHash, "erase");
    expect(verifyMemoryChain(personaPath).ok).toBe(true);
    const raw = readFileSync(join(dirname(personaPath), "memory", "episodic.jsonl"), "utf-8");
    expect(raw).not.toContain("old-format secret");
  });

  it("migrateMemoryChain remaps tombstone target tags to the new hashes", () => {
    const a = writeLegacy("first", "");
    const b = writeLegacy("second", a.hash);
    // Legacy-format tombstone written by the CURRENT engine on top of a legacy chain
    tombstoneMemory(personaPath, b.hash, "hide it");
    expect(readLiveMemory(personaPath).some((e) => e.hash === b.hash)).toBe(false);

    const { remapped } = migrateMemoryChain(personaPath);
    expect(verifyMemoryChain(personaPath).ok).toBe(true);
    // The tombstone still hides the (re-hashed) target after migration.
    const live = readLiveMemory(personaPath);
    expect(live.some((e) => e.hash === remapped[b.hash])).toBe(false);
    expect(live.some((e) => e.hash === remapped[a.hash])).toBe(true);
    expect(readMemory(personaPath).every((e) => typeof e.content_hash === "string")).toBe(true);
  });
});
