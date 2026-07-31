/**
 * MULTI-DEVICE STATE: the same persona, used on several machines, with nothing lost.
 *
 * WHY THE OLD SHAPE COULD NOT DO THIS. `state.json` is a document that gets overwritten,
 * and the memory log is one hash chain with one writer. Two machines editing either of
 * them produce last-write-wins (memory silently disappears) or a broken chain (the
 * integrity check fails and cannot say which side is right). That is not a bug to patch:
 * a single mutable file has a single writer, and here there are many.
 *
 * THE SHAPE THAT WORKS. Each device appends to ITS OWN log:
 *
 *     .personaxis/devices/<deviceId>/mutations.jsonl
 *
 * Nobody writes anybody else's file, so file-level conflict cannot happen, whatever
 * carries the folder between machines (git, Syncthing, Dropbox, a USB stick). This is the
 * per-device-file pattern local-first systems converge on, and it is the same reason
 * presence already works this way.
 *
 * The state is then a FOLD of every log in a total order, which gives three properties
 * that matter here:
 *
 *   - Deterministic: every machine folding the same entries computes the same state, so
 *     there is no "authoritative" copy to disagree with.
 *   - Envelope-preserving: the clamp is applied at every step of the fold, so T1 (a value
 *     can never leave its declared envelope) holds for merged history exactly as it does
 *     for local history. Order is not a detail here: clamp is not associative, which is
 *     precisely why the order has to be total and agreed.
 *   - Reconstructible: `state.json` becomes a cache. Delete it and it comes back.
 *
 * INTEGRITY. The hash chain is PER DEVICE. A single global chain is incompatible with
 * concurrent writers by construction. So each device's log is independently
 * tamper-evident, and a broken chain names the device and the position, instead of
 * failing globally and blaming nobody.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deviceIdentity, formatHlc, parseHlc, nextHlc, compareHlc, maxHlc, type Hlc } from "./device.js";
import type { Envelope } from "./envelopes.js";

/**
 * The envelope clamp, in the one form the fold needs.
 *
 * Deliberately the SAME arithmetic as `applyMutation` in the state engine
 * (`Math.max(min, Math.min(max, requested))`): the merged history must obey the identical
 * bound as the local one, and two implementations of "the value cannot leave its box"
 * would eventually disagree about the box.
 */
function clampToEnvelope(value: number, env: Envelope): number {
  return Math.max(env.min, Math.min(env.max, value));
}

/** One recorded change, as written by exactly one device. */
export interface DeviceMutation {
  /** Hybrid logical timestamp, serialised. Sorts correctly across machines. */
  hlc: string;
  field: string;
  /** The REQUESTED delta. What actually applied is recomputed by the fold, never trusted. */
  delta: number;
  actor?: string;
  reason?: string;
  /** Chain link over the previous entry IN THIS DEVICE'S LOG. */
  prev: string;
  hash: string;
}

export function devicesDir(personaPath: string): string {
  return join(dirname(personaPath), "devices");
}

export function deviceLogPath(personaPath: string, deviceId: string): string {
  return join(devicesDir(personaPath), deviceId, "mutations.jsonl");
}

function hashEntry(e: Omit<DeviceMutation, "hash">): string {
  return createHash("sha256")
    .update(`${e.prev}|${e.hlc}|${e.field}|${e.delta}|${e.actor ?? ""}|${e.reason ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

/** Read one device's log, in file order (which is its own causal order). */
export function readDeviceLog(personaPath: string, deviceId: string): DeviceMutation[] {
  const p = deviceLogPath(personaPath, deviceId);
  if (!existsSync(p)) return [];
  const out: DeviceMutation[] = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DeviceMutation);
    } catch {
      /* a truncated final line (an interrupted write) is skipped, not fatal */
    }
  }
  return out;
}

/** Every device that has ever written to this persona, on this copy of the folder. */
export function knownDevices(personaPath: string): string[] {
  const dir = devicesDir(personaPath);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "mutations.jsonl")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Every entry from every device, unordered. */
export function readAllLogs(personaPath: string): DeviceMutation[] {
  return knownDevices(personaPath).flatMap((d) => readDeviceLog(personaPath, d));
}

/**
 * Append a mutation to THIS device's log.
 *
 * The HLC is seeded from everything currently visible, including entries other machines
 * contributed, so a device that has just received a newer history never emits a timestamp
 * that sorts before what it has already seen.
 */
export function appendDeviceMutation(
  personaPath: string,
  m: { field: string; delta: number; actor?: string; reason?: string },
): DeviceMutation {
  const device = deviceIdentity().id;
  const own = readDeviceLog(personaPath, device);
  const seen = maxHlc(
    readAllLogs(personaPath)
      .map((e) => parseHlc(e.hlc))
      .filter((h): h is Hlc => Boolean(h)),
  );
  const entry: Omit<DeviceMutation, "hash"> = {
    hlc: formatHlc(nextHlc(device, seen)),
    field: m.field,
    delta: m.delta,
    ...(m.actor ? { actor: m.actor } : {}),
    ...(m.reason ? { reason: m.reason } : {}),
    prev: own.length ? own[own.length - 1].hash : "genesis",
  };
  const full: DeviceMutation = { ...entry, hash: hashEntry(entry) };
  const dir = join(devicesDir(personaPath), device);
  mkdirSync(dir, { recursive: true });
  appendFileSync(deviceLogPath(personaPath, device), JSON.stringify(full) + "\n", "utf-8");
  return full;
}

/**
 * Mirror a state mutation into THIS device's append-only log.
 *
 * Called wherever state is persisted, so the log is a complete record of every change and
 * `state.json` becomes a cache that can always be rebuilt from it (`sync --rebuild`).
 * Writing both is deliberate rather than transitional: the cache keeps every existing
 * reader fast and unchanged, while the log is what survives being merged with another
 * machine's.
 *
 * Best-effort by construction. A persona must keep working when this write cannot happen
 * (read-only checkout, a container, a filesystem that lost the folder); the cost is that
 * those changes are local-only, which is strictly better than refusing to run.
 */
export function mirrorMutationToLog(
  personaPath: string,
  m: { field: string; delta: number; actor?: string; reason?: string },
): void {
  try {
    appendDeviceMutation(personaPath, m);
  } catch {
    /* observability of the merge, never a precondition for mutating */
  }
}

export interface FoldResult {
  values: Record<string, number>;
  /** Entries applied, in the order they were applied. */
  applied: number;
  /** Entries whose requested delta had to be clamped to stay inside the envelope. */
  clamped: number;
  /** Devices that contributed, for an honest report of what merged. */
  devices: string[];
}

/**
 * THE FOLD: every device's entries, in one total order, clamped at each step.
 *
 * The clamp inside the loop is the whole guarantee. `clamp(a + b)` is not `clamp(a) +
 * clamp(b)`, so merging by summing deltas and clamping once at the end would let a value
 * escape its envelope through a sequence that never individually did. Applying the clamp
 * per entry, in an order every machine agrees on, is what makes the merged history obey
 * exactly the same bound as the local one.
 */
export function foldMutations(
  entries: DeviceMutation[],
  envelopes: Record<string, Envelope>,
  base: Record<string, number> = {},
): FoldResult {
  const ordered = [...entries].sort((a, b) => {
    const ha = parseHlc(a.hlc);
    const hb = parseHlc(b.hlc);
    if (!ha || !hb) return a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0;
    return compareHlc(ha, hb);
  });

  const values: Record<string, number> = { ...base };
  const devices = new Set<string>();
  let applied = 0;
  let clamped = 0;

  for (const e of ordered) {
    const env = envelopes[e.field];
    devices.add(parseHlc(e.hlc)?.device ?? "unknown");
    if (!env) continue; // a field with no declared envelope is not governed state
    const current = values[e.field] ?? env.mean;
    const requested = current + e.delta;
    const next = clampToEnvelope(requested, env);
    if (Math.abs(next - requested) > 1e-9) clamped += 1;
    values[e.field] = next;
    applied += 1;
  }
  return { values, applied, clamped, devices: [...devices].sort() };
}

export interface ChainCheck {
  device: string;
  ok: boolean;
  /** 0-based index of the first entry that does not follow from its predecessor. */
  brokenAt?: number;
  entries: number;
}

/**
 * Verify each device's chain INDEPENDENTLY.
 *
 * Per device, because one global chain cannot have two writers. The practical gain is
 * also diagnostic: a break names the device and the position, so "somebody edited the log
 * on the laptop, at entry 12" replaces "the chain is broken", which told you nothing about
 * where to look and condemned every machine at once.
 */
export function verifyDeviceChains(personaPath: string): ChainCheck[] {
  return knownDevices(personaPath).map((device) => {
    const log = readDeviceLog(personaPath, device);
    let prev = "genesis";
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      const expected = hashEntry({
        hlc: e.hlc,
        field: e.field,
        delta: e.delta,
        ...(e.actor ? { actor: e.actor } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
        prev,
      });
      if (e.prev !== prev || e.hash !== expected) {
        return { device, ok: false, brokenAt: i, entries: log.length };
      }
      prev = e.hash;
    }
    return { device, ok: true, entries: log.length };
  });
}

/** What a merge would produce, and from whom. Used by `personaxis sync` to report honestly. */
export function mergeReport(personaPath: string, envelopes: Record<string, Envelope>): FoldResult & { chains: ChainCheck[] } {
  const chains = verifyDeviceChains(personaPath);
  // A device with a broken chain is EXCLUDED from the fold rather than silently trusted:
  // tamper-evidence is worth nothing if the tampered entries still shape the result.
  const trusted = new Set(chains.filter((c) => c.ok).map((c) => c.device));
  const entries = readAllLogs(personaPath).filter((e) => trusted.has(parseHlc(e.hlc)?.device ?? ""));
  return { ...foldMutations(entries, envelopes), chains };
}
