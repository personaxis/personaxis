/**
 * E19: what happens when several personas share one machine.
 *
 * Phase 13 is built on "several personas on the same machine", and until it is measured
 * that is a hope rather than a property. This is the first thing to measure, because
 * episodic memory is a HASH CHAIN and memory.ts says the rule out loud: a chain has
 * exactly one writer, and two machines appending to one file produce links that do not
 * follow from each other.
 *
 * The split it made is per DEVICE (`episodic.<deviceId>.jsonl`), which answers the
 * question it was asked. This asks the next one: two personas on ONE device share a
 * device id, so if they also share a persona path they share the file, and "one writer"
 * stops being true for a reason the filename cannot see.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitMemoryEntry, PersonaAgent, prepareMemoryEntry, readLiveMemory, verifyMemoryChain } from "../src/index.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-conc-"));
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  personaPath = join(dir, ".personaxis", "personaxis.md");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("episodic memory under concurrent writers (E19)", () => {
  it("sequential writes keep the chain verifiable, which is the baseline", () => {
    for (let i = 0; i < 20; i++) {
      commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: `entry ${i}`, source: "internal" }));
    }
    expect(readLiveMemory(personaPath)).toHaveLength(20);
    expect(verifyMemoryChain(personaPath).ok).toBe(true);
  });

  it("INTERLEAVED writers on one path break the chain, and the check says so", () => {
    // Not a race in the timing sense: this is the deterministic shape of one. Each
    // writer prepares an entry against the state it can see and commits afterwards,
    // which is exactly what two processes on one device do when they interleave.
    const a = prepareMemoryEntry(personaPath, { content: "from persona A", source: "internal" });
    const b = prepareMemoryEntry(personaPath, { content: "from persona B", source: "internal" });
    commitMemoryEntry(personaPath, a);
    commitMemoryEntry(personaPath, b);

    // Both landed, and both claim the same predecessor, so the chain no longer follows.
    expect(readLiveMemory(personaPath)).toHaveLength(2);
    expect(a.prev_hash).toBe(b.prev_hash);
    const verdict = verifyMemoryChain(personaPath);
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBeDefined();
  });

  it("the integrity check is what catches it, so it must not be optimistic", () => {
    // A verifier that returned ok on a broken chain would make the property above
    // unobservable, and the whole guarantee rests on it. Asserted separately from the
    // case that produces the break, so a change to either is visible.
    const first = prepareMemoryEntry(personaPath, { content: "one", source: "internal" });
    commitMemoryEntry(personaPath, first);
    expect(verifyMemoryChain(personaPath).ok).toBe(true);

    const forked = prepareMemoryEntry(personaPath, { content: "two", source: "internal" });
    commitMemoryEntry(personaPath, forked);
    expect(verifyMemoryChain(personaPath).ok).toBe(true);

    // Now the shape that a second writer produces: an entry anchored to a predecessor
    // that is no longer the tail.
    const stale = { ...forked, content: "three", ts: new Date().toISOString() };
    commitMemoryEntry(personaPath, stale);
    expect(verifyMemoryChain(personaPath).ok).toBe(false);
  });
});

describe("N turns at once on one machine (E19)", () => {
  /** Answers instantly, so what is measured is the engine and not a stub's sleep. */
  const instant = (): typeof fetch =>
    (async (url: string) => {
      if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "finish", arguments: JSON.stringify({ summary: "done" }) } }] } }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }),
      };
    }) as unknown as typeof fetch;

  it("sixteen concurrent runs each keep their own accounting", async () => {
    // The failure this is looking for is shared mutable state between agents: a meter,
    // a store or a breaker reached through a module-level value rather than an
    // instance. It would show up as totals that are multiples of one turn's cost.
    const runs = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        new PersonaAgent({
          llm: { endpoint: "http://x/v1", model: "m", fetchImpl: instant() },
          policy: { sandbox: "read-only", approval: "never", allow: [], deny: [], workspaceRoot: dir },
        }).run(`task ${i}`),
      ),
    );

    expect(runs).toHaveLength(16);
    for (const r of runs) {
      expect(r.finished).toBe(true);
      // One turn's worth, not sixteen: each run counted only its own.
      expect(r.budget.tokens).toBe(110);
      expect(r.cache.calls).toBe(1);
      expect(r.latency.calls.model).toBe(1);
    }
  });

  it("a concurrent run is not slower than a lonely one by more than its share", async () => {
    // Not a millisecond budget, which would fail on a loaded machine for reasons that
    // have nothing to do with this code. A RATIO, against the same work done alone, on
    // the same machine, in the same test: the engine must not serialise what it was
    // given concurrently.
    const one = async (): Promise<number> => {
      const at = Date.now();
      await new PersonaAgent({
        llm: { endpoint: "http://x/v1", model: "m", fetchImpl: instant() },
        policy: { sandbox: "read-only", approval: "never", allow: [], deny: [], workspaceRoot: dir },
      }).run("t");
      return Date.now() - at;
    };

    const alone = await one();
    const started = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => one()));
    const together = Date.now() - started;

    // Eight at once must cost well under eight times one, or they are not concurrent at
    // all. Generous on purpose: this is a floor under a regression, not a benchmark.
    expect(together).toBeLessThan(Math.max(alone, 1) * 8);
  });
});
