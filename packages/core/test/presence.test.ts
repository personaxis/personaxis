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
  touchPresence,
  PRESENCE_STALE_MS,
  PRESENCE_HEARTBEAT_MS,
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

describe("the heartbeat and the staleness window (D6)", () => {
  it("beats several times inside the window readers judge by", () => {
    // The failure this rules out is a writer beating slower than readers expire, which
    // drops a running instance off the fleet. Three beats leaves room for a machine that
    // stalls briefly without keeping a dead one on the list.
    expect(PRESENCE_HEARTBEAT_MS).toBeLessThan(PRESENCE_STALE_MS / 2);
    expect(PRESENCE_STALE_MS / PRESENCE_HEARTBEAT_MS).toBeGreaterThanOrEqual(3);
  });
});

describe("presence driven by use, for surfaces with no loop of their own", () => {
  it("announces on first use", () => {
    touchPresence(personaPath, { host: "mcp", activity: "driven by an MCP host" });
    expect(livePresence(personaPath)).toHaveLength(1);
    expect(livePresence(personaPath)[0].host).toBe("mcp");
  });

  it("does not rewrite the file on every call", () => {
    // A chatty host calls many times a second and presence is a file write. Skipping a
    // refresh costs nothing: the entry is good for the whole staleness window.
    const t0 = Date.now();
    touchPresence(personaPath, { host: "mcp", activity: "first" }, t0);
    touchPresence(personaPath, { host: "mcp", activity: "second" }, t0 + 1);

    expect(livePresence(personaPath)[0].activity).toBe("first");
  });

  it("refreshes once the heartbeat window has passed", () => {
    const t0 = Date.now();
    touchPresence(personaPath, { host: "mcp", activity: "first" }, t0);
    touchPresence(personaPath, { host: "mcp", activity: "later" }, t0 + PRESENCE_HEARTBEAT_MS + 1);

    expect(livePresence(personaPath)[0].activity).toBe("later");
  });

  it("announces again after a release, rather than staying throttled", () => {
    // The throttle must not outlive the presence it was throttling: a server that released
    // a persona and was handed it again would otherwise stay invisible for a full window.
    touchPresence(personaPath, { host: "mcp", activity: "first" });
    releasePresence(personaPath);
    touchPresence(personaPath, { host: "mcp", activity: "handed it again" });

    expect(livePresence(personaPath)[0].activity).toBe("handed it again");
  });
});
