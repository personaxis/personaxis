/**
 * PB-T5 — episodic-ledger integrity with real erasure (MATH_CORE.md §3).
 *
 *  - a fresh chain always verifies;
 *  - ANY random tamper of an entry's committed fields (ts, content, content_hash,
 *    source, tags, prev_hash, hash) is detected;
 *  - reordering (adjacent swap) is detected;
 *  - deleting any INTERIOR entry is detected (tail truncation is the documented
 *    hash-chain limit — detectable only with an external head anchor);
 *  - redaction (real erasure) of any entry PRESERVES verification.
 *
 * FS-backed, so runs fewer cases by default (FS_NUM_RUNS); crank FC_NUM_RUNS in CI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  prepareMemoryEntry,
  commitMemoryEntry,
  verifyMemoryChain,
  readMemory,
  redactMemory,
  type MemoryEntry,
} from "../../src/index.js";
import { FS_NUM_RUNS, FS_TIMEOUT } from "./arbitraries.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-chainprop-"));
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  personaPath = join(dir, ".personaxis", "personaxis.md");
  writeFileSync(personaPath, "---\nmetadata: { name: chainprop }\n---\nbody\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ledgerPath = () => join(dirname(personaPath), "memory", "episodic.jsonl");

function buildChain(contents: string[]): MemoryEntry[] {
  rmSync(join(dirname(personaPath), "memory"), { recursive: true, force: true });
  for (const c of contents) {
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: c, source: "user" }));
  }
  return readMemory(personaPath);
}

function rewrite(entries: MemoryEntry[]): void {
  writeFileSync(ledgerPath(), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

const contentsArb = fc.array(fc.string({ minLength: 1, maxLength: 80 }), { minLength: 2, maxLength: 12 });
const TAMPERABLE = ["ts", "content", "content_hash", "source", "tags", "prev_hash", "hash"] as const;

describe("PB-T5 ledger integrity", () => {
  it("a fresh chain verifies; ANY single-field tamper of any entry is detected", () => {
    fc.assert(
      fc.property(
        contentsArb,
        fc.nat(1000),
        fc.constantFrom(...TAMPERABLE),
        (contents, pick, field) => {
          const entries = buildChain(contents);
          expect(verifyMemoryChain(personaPath).ok).toBe(true);

          const idx = pick % entries.length;
          const victim = { ...entries[idx] } as Record<string, unknown>;
          victim[field] =
            field === "tags" ? [...(victim.tags as string[]), "injected"] : `${String(victim[field])}~tampered`;
          const tampered = [...entries];
          tampered[idx] = victim as unknown as MemoryEntry;
          rewrite(tampered);

          const v = verifyMemoryChain(personaPath);
          expect(v.ok).toBe(false);
          // Detection at or before the first affected link (T5(a)).
          expect(v.brokenAt).toBeLessThanOrEqual(Math.min(idx + 1, entries.length - 1));
        },
      ),
      { numRuns: FS_NUM_RUNS },
    );
  }, FS_TIMEOUT);

  it("adjacent reorder and interior deletion are detected", () => {
    fc.assert(
      fc.property(contentsArb, fc.nat(1000), fc.boolean(), (contents, pick, doSwap) => {
        const entries = buildChain(contents);
        if (doSwap) {
          const i = pick % (entries.length - 1);
          const swapped = [...entries];
          [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
          rewrite(swapped);
        } else {
          const i = pick % (entries.length - 1); // interior only: never the tail
          rewrite(entries.filter((_, k) => k !== i));
        }
        expect(verifyMemoryChain(personaPath).ok).toBe(false);
      }),
      { numRuns: FS_NUM_RUNS },
    );
  }, FS_TIMEOUT);

  it("redaction (real erasure) preserves verification; unredacted content stays checkable", () => {
    fc.assert(
      fc.property(contentsArb, fc.nat(1000), (contents, pick) => {
        const entries = buildChain(contents);
        const idx = pick % entries.length;
        redactMemory(personaPath, entries[idx].hash, "pb-t5 erasure");
        expect(verifyMemoryChain(personaPath).ok).toBe(true);
        const after = readMemory(personaPath);
        expect(after[idx].redacted).toBe(true);
        expect(after[idx].content).toBe("[redacted]");
        // Tampering a DIFFERENT, unredacted entry's content is still caught.
        const other = (idx + 1) % entries.length;
        if (other !== idx && !after[other].redacted && !after[other].tags.includes("tombstone")) {
          const tampered = [...after];
          tampered[other] = { ...after[other], content: after[other].content + "!" };
          rewrite(tampered);
          expect(verifyMemoryChain(personaPath).ok).toBe(false);
        }
      }),
      { numRuns: FS_NUM_RUNS },
    );
  }, FS_TIMEOUT);
});
