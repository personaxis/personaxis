/**
 * V8.C: the same persona on several machines, with nothing lost.
 *
 * The properties under test are the ones the design exists for, not the happy path:
 *   - determinism: every machine folding the same entries gets the same state;
 *   - envelope preservation: merged history obeys T1 exactly as local history does;
 *   - honest integrity: a tampered device is named and excluded, not silently trusted;
 *   - clock independence: ordering survives a machine whose clock is wrong.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDeviceMutation,
  readDeviceLog,
  readAllLogs,
  knownDevices,
  foldMutations,
  verifyDeviceChains,
  mergeReport,
  deviceLogPath,
  devicesDir,
  type DeviceMutation,
} from "../src/multi-device.js";
import { nextHlc, compareHlc, formatHlc, parseHlc, maxHlc, deviceIdentity } from "../src/device.js";
import type { Envelope } from "../src/envelopes.js";

const ENV: Record<string, Envelope> = {
  "personality.traits.humor": { mean: 0.5, min: 0.3, max: 0.7 },
  "affect.baseline.mood.tone": { mean: 0.0, min: -0.5, max: 0.5 },
};

let dir: string;
let personaPath: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-md-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  savedHome = process.env.PERSONAXIS_HOME;
  process.env.PERSONAXIS_HOME = home;
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  personaPath = join(dir, ".personaxis", "personaxis.md");
  writeFileSync(personaPath, "---\nspec_version: 1.1.0\n---\n");
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.PERSONAXIS_HOME;
  else process.env.PERSONAXIS_HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

/** Write a log for a device that is NOT this machine, the way a sync would deliver it. */
function seedForeignDevice(device: string, muts: Array<{ field: string; delta: number; wall: number; counter?: number }>): void {
  const d = join(devicesDir(personaPath), device);
  mkdirSync(d, { recursive: true });
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  let prev = "genesis";
  const lines = muts.map((m) => {
    const entry = {
      hlc: formatHlc({ wall: m.wall, counter: m.counter ?? 0, device }),
      field: m.field,
      delta: m.delta,
      prev,
    };
    const hash = createHash("sha256")
      .update(`${entry.prev}|${entry.hlc}|${entry.field}|${entry.delta}||`)
      .digest("hex")
      .slice(0, 32);
    prev = hash;
    return JSON.stringify({ ...entry, hash });
  });
  writeFileSync(join(d, "mutations.jsonl"), lines.join("\n") + "\n", "utf-8");
}

describe("per-device logs", () => {
  it("this device appends only to its own file", () => {
    appendDeviceMutation(personaPath, { field: "personality.traits.humor", delta: 0.05, actor: "test" });
    const me = deviceIdentity().id;
    expect(knownDevices(personaPath)).toEqual([me]);
    expect(readDeviceLog(personaPath, me)).toHaveLength(1);
  });

  it("a second machine's log merges without touching ours", () => {
    appendDeviceMutation(personaPath, { field: "personality.traits.humor", delta: 0.05 });
    seedForeignDevice("laptop00000000aa", [{ field: "personality.traits.humor", delta: 0.05, wall: Date.now() + 1000 }]);
    expect(knownDevices(personaPath)).toHaveLength(2);
    expect(readAllLogs(personaPath)).toHaveLength(2);
    // Ours is untouched: no shared file means no clobber.
    expect(readDeviceLog(personaPath, deviceIdentity().id)).toHaveLength(1);
  });

  it("a truncated final line (an interrupted write) does not break reading", () => {
    appendDeviceMutation(personaPath, { field: "personality.traits.humor", delta: 0.05 });
    const p = deviceLogPath(personaPath, deviceIdentity().id);
    writeFileSync(p, readFileSync(p, "utf-8") + '{"hlc":"deadbeef', "utf-8");
    expect(readDeviceLog(personaPath, deviceIdentity().id)).toHaveLength(1);
  });
});

describe("the fold", () => {
  it("is deterministic: any order of the same entries gives the same state", () => {
    const t = Date.now();
    seedForeignDevice("aaaa000000000001", [{ field: "personality.traits.humor", delta: 0.1, wall: t }]);
    seedForeignDevice("bbbb000000000002", [{ field: "personality.traits.humor", delta: -0.05, wall: t + 5 }]);
    const all = readAllLogs(personaPath);
    const a = foldMutations(all, ENV);
    const b = foldMutations([...all].reverse(), ENV);
    expect(a.values).toEqual(b.values);
    expect(a.applied).toBe(b.applied);
  });

  /**
   * The property the whole design turns on. Clamping once at the end would let a value
   * escape through a sequence that never individually did, because clamp(a+b) is not
   * clamp(a)+clamp(b).
   */
  it("keeps every value inside its envelope, however the machines interleave", () => {
    const t = Date.now();
    // Two machines each push hard in the same direction, well past the ceiling.
    seedForeignDevice("aaaa000000000001", [
      { field: "personality.traits.humor", delta: 0.5, wall: t },
      { field: "personality.traits.humor", delta: 0.5, wall: t + 10 },
    ]);
    seedForeignDevice("bbbb000000000002", [
      { field: "personality.traits.humor", delta: 0.5, wall: t + 5 },
      { field: "affect.baseline.mood.tone", delta: -9, wall: t + 6 },
    ]);
    const { values, clamped } = foldMutations(readAllLogs(personaPath), ENV);
    expect(values["personality.traits.humor"]).toBeLessThanOrEqual(ENV["personality.traits.humor"].max);
    expect(values["affect.baseline.mood.tone"]).toBeGreaterThanOrEqual(ENV["affect.baseline.mood.tone"].min);
    expect(clamped).toBeGreaterThan(0);
  });

  it("ignores fields with no declared envelope: state is what the spec governs", () => {
    seedForeignDevice("aaaa000000000001", [{ field: "not.declared", delta: 1, wall: Date.now() }]);
    const { values, applied } = foldMutations(readAllLogs(personaPath), ENV);
    expect(values["not.declared"]).toBeUndefined();
    expect(applied).toBe(0);
  });

  it("rebuilds from nothing: state.json is a cache, not the source", () => {
    appendDeviceMutation(personaPath, { field: "personality.traits.humor", delta: 0.1 });
    const first = foldMutations(readAllLogs(personaPath), ENV).values;
    const again = foldMutations(readAllLogs(personaPath), ENV).values;
    expect(again).toEqual(first);
  });
});

describe("clocks", () => {
  it("orders correctly even when a machine's clock is far behind", () => {
    const now = Date.now();
    // The laptop's clock is an hour slow, but its edit happened AFTER ours: the HLC
    // carries that, because it was seeded from what it had already seen.
    const ours = { wall: now, counter: 0, device: "aaaa000000000001" };
    const laptop = nextHlc("bbbb000000000002", ours, now - 3_600_000);
    expect(compareHlc(laptop, ours)).toBeGreaterThan(0);
  });

  it("never emits a timestamp that sorts before something already seen", () => {
    const seen = { wall: Date.now() + 60_000, counter: 3, device: "other" };
    const mine = nextHlc("me", seen, Date.now());
    expect(compareHlc(mine, seen)).toBeGreaterThan(0);
  });

  it("round-trips through its serialised form, and sorts as a string too", () => {
    const a = formatHlc({ wall: 1, counter: 2, device: "d" });
    expect(parseHlc(a)).toEqual({ wall: 1, counter: 2, device: "d" });
    const later = formatHlc({ wall: 2, counter: 0, device: "d" });
    expect(a < later).toBe(true);
  });

  it("maxHlc finds the latest across devices", () => {
    const list = [
      { wall: 10, counter: 0, device: "a" },
      { wall: 10, counter: 4, device: "b" },
      { wall: 9, counter: 99, device: "c" },
    ];
    expect(maxHlc(list)).toEqual({ wall: 10, counter: 4, device: "b" });
  });
});

describe("integrity, per device", () => {
  it("each chain verifies independently", () => {
    appendDeviceMutation(personaPath, { field: "personality.traits.humor", delta: 0.05 });
    appendDeviceMutation(personaPath, { field: "personality.traits.humor", delta: 0.05 });
    seedForeignDevice("laptop00000000aa", [{ field: "personality.traits.humor", delta: 0.05, wall: Date.now() }]);
    const chains = verifyDeviceChains(personaPath);
    expect(chains).toHaveLength(2);
    expect(chains.every((c) => c.ok)).toBe(true);
  });

  it("a tampered log names the device AND the position, and is excluded from the fold", () => {
    seedForeignDevice("aaaa000000000001", [
      { field: "personality.traits.humor", delta: 0.05, wall: Date.now() },
      { field: "personality.traits.humor", delta: 0.05, wall: Date.now() + 10 },
    ]);
    seedForeignDevice("bbbb000000000002", [{ field: "personality.traits.humor", delta: 0.1, wall: Date.now() + 20 }]);
    // Edit the second entry of the first device, the way an outside edit would.
    const p = deviceLogPath(personaPath, "aaaa000000000001");
    const lines = readFileSync(p, "utf-8").trim().split("\n");
    const tampered = JSON.parse(lines[1]) as DeviceMutation;
    tampered.delta = 99;
    lines[1] = JSON.stringify(tampered);
    writeFileSync(p, lines.join("\n") + "\n", "utf-8");

    const chains = verifyDeviceChains(personaPath);
    const bad = chains.find((c) => c.device === "aaaa000000000001");
    expect(bad?.ok).toBe(false);
    expect(bad?.brokenAt, "the position is what tells you where to look").toBe(1);
    // The healthy device is untouched: one broken log does not condemn the others.
    expect(chains.find((c) => c.device === "bbbb000000000002")?.ok).toBe(true);

    // And the tampered entries do not shape the result: tamper-evidence is worth
    // nothing if the tampered data is still trusted.
    const report = mergeReport(personaPath, ENV);
    expect(report.devices).toEqual(["bbbb000000000002"]);
    expect(report.values["personality.traits.humor"]).toBeLessThan(1);
  });
});

/**
 * Episodic memory under two writers: the failure that made multi-machine impossible.
 * One chain with two appenders produces links that do not follow from each other, and
 * the integrity check correctly reports tampering while being unable to say which side
 * is right. One chain per device removes the question.
 */
describe("episodic memory across devices", () => {
  it("two devices both write, both chains verify, and recall sees one history", async () => {
    const { prepareMemoryEntry, commitMemoryEntry, readMemory, verifyMemoryChain } = await import("../src/memory.js");

    // This machine writes two entries.
    for (const text of ["learned A", "learned B"]) {
      commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: text, source: "user" }));
    }
    // A second machine arrives with its own log (its own chain, starting at "").
    process.env.PERSONAXIS_HOME = join(dir, "home-laptop");
    mkdirSync(process.env.PERSONAXIS_HOME, { recursive: true });
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "learned on the laptop", source: "user" }));

    expect(verifyMemoryChain(personaPath).ok, "each chain verifies on its own").toBe(true);
    const all = readMemory(personaPath).map((e) => e.content);
    expect(all).toHaveLength(3);
    expect(all).toContain("learned A");
    expect(all).toContain("learned on the laptop");
  });

  it("tampering with ONE device's memory names that log and leaves the others valid", async () => {
    const { prepareMemoryEntry, commitMemoryEntry, verifyMemoryChain } = await import("../src/memory.js");
    const { readdirSync, readFileSync: rf, writeFileSync: wf } = await import("node:fs");

    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "honest", source: "user" }));
    const memDir = join(dir, ".personaxis", "memory");
    const file = join(memDir, readdirSync(memDir).find((f) => f.startsWith("episodic"))!);
    const line = JSON.parse(rf(file, "utf-8").trim()) as { content: string };
    line.content = "poisoned";
    wf(file, JSON.stringify(line) + "\n", "utf-8");

    const v = verifyMemoryChain(personaPath);
    expect(v.ok).toBe(false);
    expect(v.device, "the report names WHICH log to look at").toBeTruthy();
  });
});
