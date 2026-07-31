import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { isAwake, readLiveStatus, liveMarkerPath } from "../src/fleet.js";

describe("fleet presence (V2-F4.1/F4.2)", () => {
  it("isAwake: recent ts awake, old ts idle, missing idle", () => {
    const now = Date.now();
    expect(isAwake(new Date(now - 5_000).toISOString(), now)).toBe(true);
    expect(isAwake(new Date(now - 60_000).toISOString(), now)).toBe(false);
    expect(isAwake(undefined, now)).toBe(false);
    expect(isAwake("not-a-date", now)).toBe(false);
  });

  describe("readLiveStatus", () => {
    let personaPath: string;
    beforeEach(() => {
      const dir = mkdtempSync(join(tmpdir(), "pxs-fleet-"));
      personaPath = join(dir, "personaxis.md");
    });

    it("returns idle when there is no marker", () => {
      expect(readLiveStatus(personaPath).awake).toBe(false);
    });

    it("reads a fresh marker as awake with its values", () => {
      const now = Date.now();
      mkdirSync(dirname(personaPath), { recursive: true });
      writeFileSync(
        liveMarkerPath(personaPath),
        JSON.stringify({ ts: new Date(now - 1000).toISOString(), values: { "mood.tone": 0.2 }, mutations: 3 }),
      );
      const s = readLiveStatus(personaPath, now);
      expect(s.awake).toBe(true);
      expect(s.values?.["mood.tone"]).toBe(0.2);
      expect(s.mutations).toBe(3);
    });
  });
});
