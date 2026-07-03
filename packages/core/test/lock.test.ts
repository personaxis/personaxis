import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStateLock, withStateLock, stateLockHeld } from "../src/lock.js";
import { writeState, type StateFile } from "../src/persona.js";

function tmpTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), "pxis-lock-"));
  return join(dir, "state.json");
}

const baseState: StateFile = {
  schema_version: "0.9.0",
  persona_id: "t",
  persona_version: "0.0.0",
  values: { "mood.tone": 0 },
  mutation_log: [],
};

describe("state lock", () => {
  it("acquires, holds, and releases", () => {
    const target = tmpTarget();
    const release = acquireStateLock(target);
    expect(stateLockHeld(target)).toBe(true);
    release();
    expect(stateLockHeld(target)).toBe(false);
  });

  it("withStateLock releases on throw", () => {
    const target = tmpTarget();
    expect(() =>
      withStateLock(target, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(stateLockHeld(target)).toBe(false);
  });

  it("steals a stale lock from a dead pid", () => {
    const target = tmpTarget();
    const lockDir = `${target}.lock`;
    mkdirSync(lockDir);
    // A pid that cannot be alive (max pid on Linux is < 2^22; Windows pids are DWORDs
    // but 999999999 is far beyond real allocation) + an ancient timestamp.
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 999999999, ts: 1 }), "utf-8");
    const release = acquireStateLock(target); // must steal, not time out
    expect(stateLockHeld(target)).toBe(true);
    release();
  });

  it("times out against a live holder", { timeout: 10_000 }, () => {
    const target = tmpTarget();
    const release = acquireStateLock(target); // held by THIS live process, fresh ts
    const t0 = Date.now();
    expect(() => acquireStateLock(target)).toThrow(/could not acquire state lock/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4000); // waited close to the 5s budget
    release();
  });

  it("writeState is atomic: no partial file, no stray tmp", () => {
    const target = tmpTarget();
    writeState(target, baseState);
    const parsed = JSON.parse(readFileSync(target, "utf-8"));
    expect(parsed.persona_id).toBe("t");
    // no leftover temp files beside it
    const dir = target.slice(0, target.lastIndexOf("state.json"));
    expect(existsSync(target)).toBe(true);
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("serialized read→modify→write keeps every mutation (no lost update)", () => {
    const target = tmpTarget();
    writeState(target, structuredClone(baseState));
    // Simulate N sequential "processes" doing locked RMW; each appends one log entry.
    for (let i = 0; i < 5; i++) {
      withStateLock(target, () => {
        const st = JSON.parse(readFileSync(target, "utf-8")) as StateFile;
        st.mutation_log.push({
          ts: new Date().toISOString(),
          field: "mood.tone",
          from: 0,
          to: 0,
          delta_requested: 0,
          clamped: false,
          reason: `rmw-${i}`,
          actor: "actor-llm",
        });
        writeState(target, st);
      });
    }
    const final = JSON.parse(readFileSync(target, "utf-8")) as StateFile;
    expect(final.mutation_log).toHaveLength(5);
  });
});
