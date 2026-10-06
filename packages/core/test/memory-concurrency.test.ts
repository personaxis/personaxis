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
 * question it was asked. It does not answer the next one: two personas on ONE device
 * share a device id, so if they also share a persona path they share the file, and "one
 * writer" stops being true for a reason the filename cannot see.
 *
 * E33 closed that with the answer this repo already gave one file over: the same lock
 * `state.json` uses, plus a re-anchor inside it, because the race lives BETWEEN reading
 * the tail and appending and locking only the write would produce two well-formed lines
 * that both follow the same predecessor.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitMemoryEntry, PersonaAgent, prepareMemoryEntry, readLiveMemory, verifyMemoryChain } from "../src/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));

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

  it("INTERLEAVED writers on one path keep the chain intact, because the commit re-anchors", () => {
    // The deterministic shape of the race, not a timing trick: each writer prepares an
    // entry against the tail it can see, and commits afterwards. Before E33 both landed
    // naming the same predecessor and the chain no longer followed.
    const a = prepareMemoryEntry(personaPath, { content: "from persona A", source: "internal" });
    const b = prepareMemoryEntry(personaPath, { content: "from persona B", source: "internal" });
    expect(a.prev_hash).toBe(b.prev_hash); // they did see the same tail

    const landedA = commitMemoryEntry(personaPath, a);
    const landedB = commitMemoryEntry(personaPath, b);

    expect(readLiveMemory(personaPath)).toHaveLength(2);
    // B was re-sealed against what was actually there, which is A.
    expect(landedB.prev_hash).toBe(landedA.hash);
    expect(landedB.hash).not.toBe(b.hash);
    expect(verifyMemoryChain(personaPath).ok).toBe(true);
  });

  it("the entry that LANDED is returned, so nobody keeps a hash that is not in the file", () => {
    // `scoreMemoryEntry` names what it scored by hash. A caller holding the prepared
    // entry after a re-anchor would write an evaluation about an entry nobody can find.
    const first = prepareMemoryEntry(personaPath, { content: "one", source: "internal" });
    const stale = prepareMemoryEntry(personaPath, { content: "two", source: "internal" });
    commitMemoryEntry(personaPath, first);
    const landed = commitMemoryEntry(personaPath, stale);

    const hashes = readLiveMemory(personaPath).map((e) => e.hash);
    expect(hashes).toContain(landed.hash);
    expect(hashes).not.toContain(stale.hash);
  });

  it("an uncontended write is returned unchanged, so re-anchoring costs nothing normally", () => {
    // The common case must not churn: if the tail is what the entry already names,
    // the bytes written are the bytes prepared.
    const only = prepareMemoryEntry(personaPath, { content: "alone", source: "internal" });
    const landed = commitMemoryEntry(personaPath, only);
    expect(landed).toEqual(only);
  });

  it("REAL PROCESSES: six at once on one persona still leave one verifiable chain", async () => {
    // The only test here that exercises the LOCK. Within one process the re-anchor is
    // enough on its own, so every other case in this file would pass with the lock
    // removed, and a negative control said so. Two processes can read the same tail at
    // the same instant and both re-anchor to it; only the lock stops that.
    //
    // Runs against `dist`, so it needs a build. Skipped rather than failed when there
    // is none: a test that fails because nobody ran `pnpm build` teaches people to
    // ignore it.
    const dist = join(here, "..", "dist", "index.js");
    if (!existsSync(dist)) return;

    const script = join(here, "fixtures", "append-one-memory.mjs");
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [script, personaPath, `process ${i}`], { stdio: "ignore" });
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
          child.on("error", reject);
        }),
      ),
    );

    // Every writer landed, and the chain still follows.
    expect(readLiveMemory(personaPath)).toHaveLength(6);
    expect(verifyMemoryChain(personaPath).ok).toBe(true);
  }, 30_000);

  it("many interleaved writers still produce one verifiable chain", () => {
    // Ten entries all prepared against an empty log, then committed in order: the
    // worst case the shape allows, and the one the per-device split could not survive.
    const prepared = Array.from({ length: 10 }, (_, i) =>
      prepareMemoryEntry(personaPath, { content: `writer ${i}`, source: "internal" }),
    );
    for (const e of prepared) commitMemoryEntry(personaPath, e);

    expect(readLiveMemory(personaPath)).toHaveLength(10);
    expect(verifyMemoryChain(personaPath).ok).toBe(true);
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
