/**
 * Optional write lease (V8.D4).
 *
 * The multi-writer model makes concurrent evolution SAFE: every writer owns its own chain,
 * and the fold applies the clamp per step, so two machines evolving at once still land
 * inside the envelope. Safe is not the same as wanted. Someone running a long unattended
 * loop on one machine may prefer that a second machine cannot touch the persona at all
 * while it runs, so that the resulting history has one obvious author.
 *
 * Hence: opt-in, and never a precondition. With no lease taken, everything behaves exactly
 * as before; the lease only ever ADDS a restriction its holder asked for.
 *
 * Correctness rests on two things:
 *   - Exclusive creation (`wx`) is the only atomic primitive a plain filesystem gives us,
 *     so the lease is taken by creating a guard file, not by writing the lease itself.
 *   - A lease expires. A machine that crashes holding it must not lock the persona
 *     forever, so a stale lease is reclaimable, and reclaiming is recorded as such.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { machineId } from "./registry.js";
import { PRESENCE_STALE_MS } from "./presence.js";

/**
 * Who is holding it, which decides how it expires.
 *
 * `session`: a running process holds it and renews on a heartbeat; if it dies, the lease
 * must expire or a crash would lock the persona forever.
 * `manual`: a person took it deliberately (`personaxis lease take`) and the process exited
 * immediately. Expiring that after ninety seconds would make the command pointless, so it
 * lives until someone releases it, and belongs to the MACHINE rather than to a dead pid.
 */
export type LeaseHolder = "session" | "manual";

export interface Lease {
  holder: LeaseHolder;
  deviceId: string;
  /** Readable machine name: whoever is locked out needs to know WHICH machine to go to. */
  machine: string;
  user: string;
  pid: number;
  sessionId?: string;
  /** Why the holder took it, shown verbatim to whoever is blocked. */
  reason?: string;
  /** When the lease was first taken (survives renewals). */
  since: string;
  /** Last renewal. Freshness is judged from this. */
  ts: string;
}

/**
 * A lease older than this is dead and may be reclaimed.
 *
 * Same window as presence on purpose: a holder that is alive enough to heartbeat its
 * presence is alive enough to hold the lease, and one clock for "still there" is easier to
 * reason about than two that can disagree.
 */
export const LEASE_STALE_MS = PRESENCE_STALE_MS;

export type LeaseOutcome =
  /**
   * Taken: `fresh` nobody held it, `renewed` we already did, `reclaimed` the holder's
   * session died, `forced` we broke someone else's live hold on purpose.
   */
  | { ok: true; lease: Lease; how: "fresh" | "renewed" | "reclaimed" | "forced"; brokeHold?: Lease }
  /** Refused: someone else holds a live lease. */
  | { ok: false; heldBy: Lease };

function leaseFile(personaPath: string): string {
  return join(dirname(personaPath), "lease.json");
}

function guardFile(personaPath: string): string {
  return join(dirname(personaPath), "lease.guard");
}

function read(personaPath: string): Lease | undefined {
  try {
    const raw = readFileSync(leaseFile(personaPath), "utf-8");
    const l = JSON.parse(raw) as Lease;
    return typeof l?.deviceId === "string" && typeof l?.ts === "string" ? l : undefined;
  } catch {
    return undefined;
  }
}

/** Is this lease still alive at `now`? A manual hold does not age out; a session does. */
export function leaseIsLive(lease: Lease, now = Date.now()): boolean {
  if (lease.holder === "manual") return true;
  const age = now - Date.parse(lease.ts);
  return Number.isFinite(age) && age <= LEASE_STALE_MS;
}

/**
 * Were WE the ones who took it?
 *
 * A session lease is (device, pid): two REPLs on one machine are two writers, and the
 * point of the lease is to serialise writers. A manual lease is (device): the person took
 * it for this machine, and every command they run afterwards is still them.
 */
export function isOwnLease(lease: Lease): boolean {
  if (lease.deviceId !== machineId()) return false;
  return lease.holder === "manual" || lease.pid === process.pid;
}

/** The live lease on this persona, if any. A stale one reads as no lease. */
export function readLease(personaPath: string, now = Date.now()): Lease | undefined {
  const l = read(personaPath);
  return l && leaseIsLive(l, now) ? l : undefined;
}

/**
 * Hold the guard file for the length of one critical section.
 *
 * `wx` fails if the file exists, which is what makes this a mutex rather than a wish. A
 * guard left behind by a crash expires on the same rule as the lease, otherwise a single
 * crash at the wrong instant would wedge the persona permanently.
 */
function withGuard<T>(personaPath: string, now: number, fn: () => T): T | undefined {
  const g = guardFile(personaPath);
  try {
    mkdirSync(dirname(g), { recursive: true });
  } catch {
    return undefined;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(g, `${machineId()}:${process.pid}:${now}\n`, { flag: "wx" });
    } catch {
      // Held by someone. If that guard is ancient it belongs to a dead process.
      let stale = false;
      try {
        const at = Number(readFileSync(g, "utf-8").trim().split(":")[2]);
        stale = !Number.isFinite(at) || now - at > LEASE_STALE_MS;
      } catch {
        stale = true;
      }
      if (!stale) return undefined;
      try {
        unlinkSync(g);
      } catch {
        return undefined;
      }
      continue;
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(g);
      } catch {
        /* our own guard; if it is already gone the section still completed */
      }
    }
  }
  return undefined;
}

function writeLease(personaPath: string, lease: Lease): void {
  const file = leaseFile(personaPath);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lease, null, 2) + "\n", "utf-8");
  renameSync(tmp, file);
}

/**
 * Take (or renew) the write lease.
 *
 * Refusing is a normal outcome, not an error: the caller decides whether to continue
 * read-only or to stop, and the returned holder tells the person exactly who to go ask.
 */
export function acquireLease(
  personaPath: string,
  info: { sessionId?: string; reason?: string; holder?: LeaseHolder; force?: boolean } = {},
  now = Date.now(),
): LeaseOutcome {
  const attempt = withGuard(personaPath, now, (): LeaseOutcome => {
    const current = read(personaPath);
    const live = current && leaseIsLive(current, now);
    // `force` exists because a manual lease never expires: without a way to break one, a
    // machine that is switched off with the lease held would strand the persona for good.
    // It is deliberate, it is loud, and it records whose hold it broke.
    if (live && current && !isOwnLease(current) && !info.force) return { ok: false, heldBy: current };

    const iso = new Date(now).toISOString();
    const mine = live && current && isOwnLease(current);
    const lease: Lease = {
      holder: info.holder ?? "session",
      deviceId: machineId(),
      machine: hostname(),
      user: userInfo().username,
      pid: process.pid,
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
      ...(info.reason ? { reason: info.reason } : {}),
      since: mine ? current.since : iso,
      ts: iso,
    };
    const broke = live && current && !isOwnLease(current) ? current : undefined;
    writeLease(personaPath, lease);
    const how = broke ? "forced" : mine ? "renewed" : current ? "reclaimed" : "fresh";
    return { ok: true, lease, how, ...(broke ? { brokeHold: broke } : {}) };
  });

  // The guard was busy. Treat that as "someone else is acting on this persona right now"
  // rather than inventing a lease we did not actually take.
  if (!attempt) {
    const current = read(personaPath);
    if (current && leaseIsLive(current, now) && !isOwnLease(current)) return { ok: false, heldBy: current };
    const unknown: Lease = {
      holder: "session",
      deviceId: "unknown",
      machine: "unknown",
      user: "unknown",
      pid: 0,
      reason: "another process is mid-acquire",
      since: new Date(now).toISOString(),
      ts: new Date(now).toISOString(),
    };
    return { ok: false, heldBy: current ?? unknown };
  }
  return attempt;
}

/**
 * Give the lease back. Only the holder can, so a read-only instance calling this by mistake
 * cannot free a lease another machine is actively using.
 */
export function releaseLease(personaPath: string): boolean {
  const current = read(personaPath);
  if (!current || !isOwnLease(current)) return false;
  try {
    unlinkSync(leaseFile(personaPath));
    return true;
  } catch {
    return false;
  }
}

/** Whether THIS process may write, given the lease state. No lease means yes. */
export function mayWrite(personaPath: string, now = Date.now()): boolean {
  const held = readLease(personaPath, now);
  return !held || isOwnLease(held);
}

/** One line for a status bar or a refusal message. */
export function describeLease(lease: Lease, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(lease.since)) / 60_000));
  const where = lease.deviceId === machineId() ? "this machine" : lease.machine;
  const held = mins < 1 ? "just now" : `${mins}m`;
  return `${where} (${lease.user}, pid ${lease.pid}) for ${held}${lease.reason ? ` · ${lease.reason}` : ""}`;
}
