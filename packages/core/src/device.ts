/**
 * DEVICE IDENTITY + HYBRID LOGICAL CLOCK: the two primitives multi-device sync needs
 * before anything else can be written down.
 *
 * A persona used on two machines produces two streams of changes that must be merged into
 * one history. Merging needs two things that sound trivial and are not:
 *
 *   1. WHO wrote this, stably, across restarts and across clock changes.
 *   2. WHAT ORDER did things happen in, when the writers never talked to each other.
 *
 * Wall-clock timestamps cannot answer (2). Clocks drift, get corrected, jump at DST, and
 * are simply wrong on machines nobody maintains; two events a second apart can carry
 * timestamps in the wrong order, and a merge that trusts them produces a history that
 * never happened. A hybrid logical clock keeps physical time as a hint (so the log is
 * still readable by a person) while guaranteeing that causally later events sort later,
 * whatever the clocks say.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { hostname, platform, userInfo } from "node:os";
import { join } from "node:path";
import { personaxisHome } from "./registry.js";

export interface DeviceIdentity {
  /** Stable across restarts, unique per machine+user. */
  id: string;
  /** The name a person recognises; never used for identity. */
  label: string;
  os: string;
  createdTs: string;
}

function deviceFile(): string {
  return join(personaxisHome(), "device.json");
}

/**
 * This machine's identity, created once and then read.
 *
 * PERSISTED rather than derived, unlike the older `machineId()` hash of
 * hostname+platform+user. A derived id silently changes when someone renames their
 * computer, and in a synced history that reads as a brand new device whose entries
 * interleave with the old ones under a different name. Persisting it means the identity
 * outlives cosmetic changes; the random component means two machines that happen to share
 * a hostname and username are still distinct.
 */
export function deviceIdentity(): DeviceIdentity {
  const f = deviceFile();
  if (existsSync(f)) {
    try {
      const d = JSON.parse(readFileSync(f, "utf-8")) as DeviceIdentity;
      if (d?.id) return d;
    } catch {
      /* unreadable: fall through and mint a new one rather than fail every command */
    }
  }
  const identity: DeviceIdentity = {
    id: createHash("sha256").update(`${hostname()}|${userInfo().username}|${randomUUID()}`).digest("hex").slice(0, 16),
    label: hostname(),
    os: platform(),
    createdTs: new Date().toISOString(),
  };
  try {
    mkdirSync(personaxisHome(), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(identity, null, 2) + "\n", "utf-8");
    renameSync(tmp, f);
  } catch {
    /* read-only home: the identity is still valid for this process */
  }
  return identity;
}

/**
 * A Hybrid Logical Clock timestamp.
 *
 * `wall` is physical milliseconds, kept only so a human reading the log sees roughly when
 * something happened. `counter` breaks ties and, crucially, keeps advancing when the wall
 * clock stands still or goes backwards. Ordering compares `wall`, then `counter`, then
 * `device`, which makes it a TOTAL order: any two entries from anywhere compare, and every
 * machine folding the same set gets the same sequence.
 */
export interface Hlc {
  wall: number;
  counter: number;
  device: string;
}

/** Serialised form, sortable as a plain string: `000001a2b3c4-0007-<device>`. */
export function formatHlc(h: Hlc): string {
  return `${h.wall.toString(16).padStart(12, "0")}-${h.counter.toString(16).padStart(4, "0")}-${h.device}`;
}

export function parseHlc(s: string): Hlc | undefined {
  const m = /^([0-9a-f]{12})-([0-9a-f]{4})-(.+)$/.exec(s);
  return m ? { wall: parseInt(m[1], 16), counter: parseInt(m[2], 16), device: m[3] } : undefined;
}

/**
 * The next timestamp from this device, given the latest one it has SEEN (its own or
 * another machine's).
 *
 * The rule that makes it correct: never emit a timestamp that sorts before something
 * already observed. If physical time has moved past everything seen, use it and reset the
 * counter (so the log stays readable). Otherwise keep the observed wall time and bump the
 * counter, which is what protects the order when a clock is wrong, frozen, or corrected
 * backwards mid-session.
 */
export function nextHlc(device: string, seen?: Hlc, now = Date.now()): Hlc {
  if (!seen || now > seen.wall) return { wall: now, counter: 0, device };
  return { wall: seen.wall, counter: seen.counter + 1, device };
}

/** Total order over HLCs: wall, then counter, then device id as the final tiebreak. */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.wall !== b.wall) return a.wall - b.wall;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.device < b.device ? -1 : a.device > b.device ? 1 : 0;
}

/** The latest of a set, or undefined when empty. Used to seed `nextHlc` after a merge. */
export function maxHlc(list: Hlc[]): Hlc | undefined {
  return list.length ? list.reduce((a, b) => (compareHlc(a, b) >= 0 ? a : b)) : undefined;
}

/**
 * How far this device's clock is from what it has observed elsewhere.
 *
 * Reported rather than silently absorbed: the HLC keeps ORDER correct no matter how wrong
 * a clock is, but a machine hours off still writes misleading `wall` values, and a human
 * reading the timeline deserves to be told rather than left to wonder.
 */
export function clockSkewMs(seen: Hlc | undefined, now = Date.now()): number {
  return seen ? seen.wall - now : 0;
}
