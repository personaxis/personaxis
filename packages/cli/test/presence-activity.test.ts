/**
 * V9 / G.2: the fleet must show what a persona is DOING, not a permanent "idle". This tests the
 * producer path: `noteActivity` updates the session's activity and re-announces it, and
 * `livePresence` surfaces the real value. (The Command Center's activityNode already renders
 * `presence.activity`; the poll/refresh is the navigator's job in G.4.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { livePresence } from "@personaxis/core";
import { writeStarterPersona } from "../src/starter.js";
import { makeCtx } from "../src/repl/session.js";
import { makeMeter } from "../src/repl/config.js";
import { noteActivity } from "../src/repl/index.js";

let dir: string;
let personaPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-activity-"));
  personaPath = writeStarterPersona(dir, "Vega");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("live activity (G.2)", () => {
  it("a fresh session starts idle", () => {
    const ctx = makeCtx(personaPath, makeMeter());
    expect(ctx.presence.activity).toBe("idle");
  });

  it("noteActivity publishes a real activity that livePresence surfaces", () => {
    const ctx = makeCtx(personaPath, makeMeter());
    noteActivity(ctx, "answering");
    expect(ctx.presence.activity).toBe("answering");
    const live = livePresence(personaPath);
    expect(live.length, "the instance is present").toBeGreaterThan(0);
    expect(live[0].activity, "and it reports what it is doing").toBe("answering");
  });

  it("returns to idle after the activity ends", () => {
    const ctx = makeCtx(personaPath, makeMeter());
    noteActivity(ctx, "answering");
    noteActivity(ctx, "idle");
    expect(ctx.presence.activity).toBe("idle");
    expect(livePresence(personaPath)[0].activity).toBe("idle");
  });
});
