/**
 * PRESENCE: who is using this persona right now, and from where.
 *
 * The old answer was a single `.live.json` marker that said "awake" or nothing, which
 * cannot describe reality: the same persona may be open in a REPL on this machine, driven
 * by Claude Code on a laptop, and served over HTTP to a third agent, all at once. A
 * boolean collapses three different situations into one word and answers none of the
 * questions you actually have ("is someone else editing this?", "which agent is using it?",
 * "is that instance still alive or did it crash?").
 *
 * ONE FILE PER INSTANCE, never a shared one:
 *
 *     .personaxis/presence/<deviceId>-<pid>.json
 *
 * Each process writes only its own file, so concurrent instances never overwrite each
 * other and no locking is needed. That is the same property multi-device sync needs, for
 * the same reason: a single mutable file has a single writer, and we have many.
 *
 * A stale file is not evidence of a live instance: a crashed process cannot clean up after
 * itself, so readers judge by the heartbeat's age and delete what is clearly dead. This is
 * the lesson from a registry that once accumulated 26 phantom projects: anything that can
 * accumulate must have someone whose job is to remove it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { machineId } from "./registry.js";

/** Where a persona's instances announce themselves. */
export function presenceDir(personaPath: string): string {
  return join(dirname(personaPath), "presence");
}

/**
 * The surface driving the persona. Knowing WHICH agent holds it is half the value.
 *
 * The host answers "through what is this persona being used"; `activity` answers "what is
 * it doing". Keeping those apart is why `watch` and a one-shot `compile` share a host: both
 * hold the persona to produce its compiled document, and the activity says which is which.
 * Adding a host per command would grow a vocabulary nobody could read at a glance.
 */
export type PresenceHost =
  | "repl"
  | "headless"
  | "claude-code"
  | "codex"
  | "openclaw"
  | "hermes"
  | "mcp"
  | "serve"
  | "loop"
  | "compile"
  | "task";

export interface Presence {
  deviceId: string;
  /** Human-readable machine name, because a hash means nothing to the person reading it. */
  machine: string;
  user: string;
  pid: number;
  host: PresenceHost;
  /** Project root, so the fleet can say WHERE this instance is working. */
  project?: string;
  sessionId?: string;
  /** What it is doing right now, in plain words ("answering a turn", "idle"). */
  activity?: string;
  /** When this instance attached. */
  since: string;
  /** Last heartbeat. Freshness is judged from this, never from the file's mtime. */
  ts: string;
}

/**
 * Heartbeats older than this are treated as dead.
 *
 * Generous on purpose: a persona sitting at a prompt while someone thinks is idle, not
 * gone, and killing it off the list because nobody typed for a minute would be worse than
 * showing it a little too long. Writers refresh well inside this window.
 */
export const PRESENCE_STALE_MS = 90_000;

/**
 * How often a long-running holder refreshes its heartbeat.
 *
 * DERIVED, never a second literal: a writer beating slower than readers expire would drop
 * off the fleet while still running, and the two numbers drifting apart is exactly how that
 * happens. A third of the window means three missed beats before anyone is declared dead,
 * which survives a machine that stalls briefly without keeping a corpse on the list.
 */
export const PRESENCE_HEARTBEAT_MS = Math.floor(PRESENCE_STALE_MS / 3);

function presenceFile(personaPath: string, pid = process.pid): string {
  return join(presenceDir(personaPath), `${machineId()}-${pid}.json`);
}

/**
 * Announce (or refresh) this process's presence. Best-effort: a persona must keep working
 * on a read-only filesystem, in a container, or wherever this write cannot happen.
 */
export function announcePresence(
  personaPath: string,
  info: { host: PresenceHost; project?: string; sessionId?: string; activity?: string },
): void {
  try {
    const dir = presenceDir(personaPath);
    mkdirSync(dir, { recursive: true });
    const file = presenceFile(personaPath);
    const prior = existsSync(file) ? (safeRead(file)?.since ?? undefined) : undefined;
    const now = new Date().toISOString();
    const entry: Presence = {
      deviceId: machineId(),
      machine: hostname(),
      user: userInfo().username,
      pid: process.pid,
      host: info.host,
      ...(info.project ? { project: info.project } : {}),
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
      ...(info.activity ? { activity: info.activity } : {}),
      since: prior ?? now,
      ts: now,
    };
    // Atomic: a reader must never catch a half-written file and conclude the instance
    // is corrupt (it would then be deleted as unreadable).
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n", "utf-8");
    renameSync(tmp, file);
  } catch {
    /* presence is observability, never a precondition for running */
  }
}

/**
 * Refresh presence because the persona was just USED, at most once per heartbeat.
 *
 * For surfaces with no loop of their own to hang a timer on: the MCP server does not hold a
 * persona, it is handed one per call, and it has no way to know the host has walked away.
 * Use drives the refresh, and silence lets the entry expire on its own, which says exactly
 * the right thing: nobody is driving this persona right now. A timer would have kept
 * claiming otherwise while the host sat idle.
 *
 * Throttled because a chatty host can call many times a second and presence is a file
 * write. Skipping a refresh is free; the window is a third of the staleness budget.
 */
const lastTouch = new Map<string, number>();
export function touchPresence(
  personaPath: string,
  info: { host: PresenceHost; project?: string; sessionId?: string; activity?: string },
  now = Date.now(),
): void {
  const prev = lastTouch.get(personaPath);
  if (prev !== undefined && now - prev < PRESENCE_HEARTBEAT_MS) return;
  // This map is the one thing here that can grow, so it gets the same treatment as the
  // presence directory: entries past the staleness window are dropped as they are noticed.
  // A long-lived server handed many personas would otherwise keep every path it ever saw.
  if (lastTouch.size > 64) {
    for (const [path, ts] of lastTouch) if (now - ts > PRESENCE_STALE_MS) lastTouch.delete(path);
  }
  lastTouch.set(personaPath, now);
  announcePresence(personaPath, info);
}

/** Withdraw this process's presence on a clean exit. */
export function releasePresence(personaPath: string): void {
  try {
    lastTouch.delete(personaPath);
    const f = presenceFile(personaPath);
    if (existsSync(f)) unlinkSync(f);
  } catch {
    /* a crash skips this; readers fall back to the heartbeat age */
  }
}

function safeRead(file: string): Presence | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Presence;
  } catch {
    return undefined;
  }
}

/**
 * Every instance currently holding this persona, newest heartbeat first.
 *
 * Self-healing: files whose heartbeat has expired are deleted as they are found, so a
 * crashed process cannot haunt the fleet forever. The delete is best-effort; another
 * reader may win the race, which is harmless.
 */
export function livePresence(personaPath: string, now = Date.now()): Presence[] {
  const dir = presenceDir(personaPath);
  if (!existsSync(dir)) return [];
  const out: Presence[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  for (const f of files) {
    const full = join(dir, f);
    const p = safeRead(full);
    const age = p ? now - Date.parse(p.ts) : Number.POSITIVE_INFINITY;
    if (!p || !Number.isFinite(age) || age > PRESENCE_STALE_MS) {
      try {
        unlinkSync(full);
      } catch {
        /* someone else removed it, or it is read-only: not our problem to solve here */
      }
      continue;
    }
    out.push(p);
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

/** Is this instance the only one holding the persona? Used to warn before concurrent edits. */
export function otherInstances(personaPath: string): Presence[] {
  const me = process.pid;
  const mine = machineId();
  return livePresence(personaPath).filter((p) => !(p.pid === me && p.deviceId === mine));
}

/** One-line summary for a fleet row: "2 instances · this machine (repl) · laptop (claude-code)". */
export function describePresence(list: Presence[], selfDevice = machineId()): string {
  if (!list.length) return "idle";
  return list
    .map((p) => `${p.deviceId === selfDevice ? "this machine" : p.machine} (${p.host})`)
    .join(" · ");
}
