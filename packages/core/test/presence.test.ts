/**
 * V8.D: who is holding this persona right now.
 *
 * "awake: true/false" could not describe reality: the same persona may be open in a REPL
 * here, driven by Claude Code on a laptop, and served over HTTP to a third agent, all at
 * once. And the thing that bit us before is the other half: anything that accumulates
 * needs someone whose job is to remove it (a registry once carried 26 phantom projects).
 * A crashed process cannot clean up after itself, so readers must not trust the file's
 * existence, only its heartbeat.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  announcePresence,
  releasePresence,
  livePresence,
  otherInstances,
  describePresence,
  presenceDir,
  PRESENCE_STALE_MS,
} from "../src/presence.js";

let dir: string;
let personaPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-presence-"));
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  personaPath = join(dir, ".personaxis", "personaxis.md");
  writeFileSync(personaPath, "---\nspec_version: 1.1.0\n---\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("presence", () => {
  it("announces this instance with the surface driving it", () => {
    announcePresence(personaPath, { host: "repl", project: dir, activity: "idle" });
    const live = livePresence(personaPath);
    expect(live).toHaveLength(1);
    expect(live[0].host).toBe("repl");
    expect(live[0].pid).toBe(process.pid);
    expect(live[0].project).toBe(dir);
  });

  it("refreshing keeps the original attach time, so 'since' means since", async () => {
    announcePresence(personaPath, { host: "repl" });
    const first = livePresence(personaPath)[0].since;
    await new Promise((r) => setTimeout(r, 12));
    announcePresence(personaPath, { host: "repl", activity: "answering a turn" });
    const after = livePresence(personaPath)[0];
    expect(after.since).toBe(first);
    expect(after.ts >= first).toBe(true);
    expect(after.activity).toBe("answering a turn");
  });

  it("a clean exit withdraws the instance", () => {
    announcePresence(personaPath, { host: "repl" });
    expect(livePresence(personaPath)).toHaveLength(1);
    releasePresence(personaPath);
    expect(livePresence(personaPath)).toHaveLength(0);
  });

  /** The case a crash produces: the file is there, the process is not. */
  it("a stale heartbeat is not a live instance, and the corpse is removed", () => {
    const d = presenceDir(personaPath);
    mkdirSync(d, { recursive: true });
    const dead = join(d, "othermachine-9999.json");
    const old = new Date(Date.now() - PRESENCE_STALE_MS - 60_000).toISOString();
    writeFileSync(
      dead,
      JSON.stringify({ deviceId: "othermachine", machine: "laptop", user: "x", pid: 9999, host: "repl", since: old, ts: old }),
    );
    expect(existsSync(dead)).toBe(true);
    expect(livePresence(personaPath)).toHaveLength(0);
    expect(existsSync(dead), "a dead instance must not haunt the fleet").toBe(false);
  });

  it("an unreadable file is discarded, not treated as an instance", () => {
    const d = presenceDir(personaPath);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "broken-1.json"), "{ not json");
    expect(livePresence(personaPath)).toHaveLength(0);
    expect(readdirSync(d)).toHaveLength(0);
  });

  it("lists CONCURRENT instances from different machines and surfaces", () => {
    announcePresence(personaPath, { host: "repl" });
    const d = presenceDir(personaPath);
    const now = new Date().toISOString();
    writeFileSync(
      join(d, "laptop-4242.json"),
      JSON.stringify({ deviceId: "laptop", machine: "MacBook", user: "me", pid: 4242, host: "claude-code", since: now, ts: now }),
    );
    const live = livePresence(personaPath);
    expect(live).toHaveLength(2);
    expect(live.map((p) => p.host).sort()).toEqual(["claude-code", "repl"]);

    // "Is anyone ELSE using it?" is the question that matters before a concurrent edit.
    const others = otherInstances(personaPath);
    expect(others).toHaveLength(1);
    expect(others[0].machine).toBe("MacBook");

    const summary = describePresence(live);
    expect(summary).toContain("claude-code");
    expect(summary).toContain("MacBook");
  });

  it("no presence directory means idle, not a crash", () => {
    expect(livePresence(personaPath)).toEqual([]);
    expect(describePresence([])).toBe("idle");
  });
});
