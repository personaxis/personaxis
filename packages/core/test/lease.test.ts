/**
 * V8.D4: the optional write lease.
 *
 * What matters here is not the happy path but the three ways a lock ruins a product:
 * it locks you out of your own persona, it survives the crash of whoever took it, or two
 * machines both believe they hold it. One test each.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  acquireLease,
  releaseLease,
  readLease,
  mayWrite,
  isOwnLease,
  describeLease,
  LEASE_STALE_MS,
  leaseIsLive,
  type Lease,
} from "../src/lease.js";
import { machineId } from "../src/registry.js";

let dir: string;
let personaPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-lease-"));
  personaPath = join(dir, "personaxis.md");
  writeFileSync(personaPath, "# persona\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const leaseFile = (): string => join(dirname(personaPath), "lease.json");

/** A lease belonging to some OTHER machine, at an age we choose. */
function foreignLease(ageMs: number, holder: "session" | "manual" = "session"): Lease {
  const iso = new Date(Date.now() - ageMs).toISOString();
  return {
    holder,
    deviceId: "other-device-0000",
    machine: "laptop",
    user: "someone",
    pid: 4242,
    reason: "overnight loop",
    since: iso,
    ts: iso,
  };
}

describe("the write lease is opt-in and never blocks by default", () => {
  it("with no lease taken, writing is allowed", () => {
    expect(readLease(personaPath)).toBeUndefined();
    expect(mayWrite(personaPath)).toBe(true);
  });

  it("taking it once, then again from the same process, renews rather than duplicating", () => {
    const first = acquireLease(personaPath, { reason: "long run" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.how).toBe("fresh");

    const again = acquireLease(personaPath);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.how, "the holder must not lock itself out").toBe("renewed");
    // Renewing preserves when it was FIRST taken, which is what the status line shows.
    expect(again.lease.since).toBe(first.lease.since);
    expect(mayWrite(personaPath)).toBe(true);
  });

  it("releasing frees it for everyone", () => {
    acquireLease(personaPath);
    expect(releaseLease(personaPath)).toBe(true);
    expect(readLease(personaPath)).toBeUndefined();
    expect(existsSync(leaseFile())).toBe(false);
  });
});

describe("a live lease held elsewhere blocks, and says who has it", () => {
  beforeEach(() => writeFileSync(leaseFile(), JSON.stringify(foreignLease(1_000))));

  it("refuses and names the holder", () => {
    const r = acquireLease(personaPath);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.heldBy.machine).toBe("laptop");
    // The refusal must be actionable: which machine, which user, and why.
    const line = describeLease(r.heldBy);
    expect(line).toContain("laptop");
    expect(line).toContain("someone");
    expect(line).toContain("overnight loop");
  });

  it("marks this process read-only", () => {
    expect(mayWrite(personaPath)).toBe(false);
  });

  it("cannot be released by a process that does not hold it", () => {
    expect(releaseLease(personaPath), "releasing someone else's lease would defeat it").toBe(false);
    expect(readLease(personaPath)).toBeDefined();
  });
});

describe("a dead holder does not lock the persona forever", () => {
  it("an expired lease is reclaimable, and the reclaim is reported as such", () => {
    writeFileSync(leaseFile(), JSON.stringify(foreignLease(LEASE_STALE_MS + 60_000)));
    expect(readLease(personaPath), "an expired lease reads as no lease").toBeUndefined();
    expect(mayWrite(personaPath)).toBe(true);

    const r = acquireLease(personaPath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.how, "taking over from a dead holder is not the same as a fresh take").toBe("reclaimed");
    expect(isOwnLease(r.lease)).toBe(true);
    expect(r.lease.deviceId).toBe(machineId());
  });

  it("a guard file left by a crash expires too", () => {
    const guard = join(dirname(personaPath), "lease.guard");
    // Written as if by a process that died mid-section, long ago.
    writeFileSync(guard, `zombie:999:${Date.now() - LEASE_STALE_MS - 60_000}\n`);
    const r = acquireLease(personaPath);
    expect(r.ok, "a stale guard must not wedge the lease permanently").toBe(true);
  });

  it("a guard held RIGHT NOW makes the attempt fail rather than barge in", () => {
    const guard = join(dirname(personaPath), "lease.guard");
    writeFileSync(guard, `other:999:${Date.now()}\n`);
    const r = acquireLease(personaPath);
    expect(r.ok, "someone is mid-acquire; guessing would be how two holders happen").toBe(false);
  });
});

describe("the lease file itself", () => {
  it("is written whole, never half", () => {
    acquireLease(personaPath, { sessionId: "s-1", reason: "publishing" });
    const parsed = JSON.parse(readFileSync(leaseFile(), "utf-8")) as Lease;
    expect(parsed.sessionId).toBe("s-1");
    expect(parsed.reason).toBe("publishing");
    expect(parsed.pid).toBe(process.pid);
    expect(Number.isFinite(Date.parse(parsed.ts))).toBe(true);
  });

  it("garbage in the lease file reads as no lease instead of throwing", () => {
    writeFileSync(leaseFile(), "{not json");
    expect(readLease(personaPath)).toBeUndefined();
    expect(mayWrite(personaPath)).toBe(true);
    expect(acquireLease(personaPath).ok).toBe(true);
  });
});

/**
 * A lease taken by hand and one held by a running session cannot expire the same way.
 *
 * This is not a hypothetical: `personaxis lease take` exits immediately, so under a
 * heartbeat rule the hold it just took would be dead ninety seconds later and would have
 * blocked its OWN machine in the meantime, since a session lease is keyed to a pid that no
 * longer exists.
 */
describe("a hold taken by hand behaves differently from a running session", () => {
  it("a manual hold does not age out", () => {
    const ancient = { ...foreignLease(LEASE_STALE_MS * 100, "manual") };
    expect(leaseIsLive(ancient), "a manual hold waits for a release, not for a clock").toBe(true);
  });

  it("a manual hold belongs to the MACHINE, so later commands there still may write", () => {
    const r = acquireLease(personaPath, { holder: "manual", reason: "publishing" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Simulate the next command: same machine, different pid.
    const asAnotherProcess: Lease = { ...r.lease, pid: r.lease.pid + 1 };
    expect(isOwnLease(asAnotherProcess), "the person who took it is still the person").toBe(true);

    // ...whereas a SESSION lease is per process, because two REPLs are two writers.
    expect(isOwnLease({ ...asAnotherProcess, holder: "session" })).toBe(false);
  });

  it("another machine's manual hold blocks until forced, and forcing says whose it was", () => {
    writeFileSync(leaseFile(), JSON.stringify(foreignLease(LEASE_STALE_MS * 10, "manual")));
    expect(mayWrite(personaPath), "an old manual hold still blocks").toBe(false);

    const refused = acquireLease(personaPath, { holder: "manual" });
    expect(refused.ok).toBe(false);

    const forced = acquireLease(personaPath, { holder: "manual", force: true });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(forced.how).toBe("forced");
    // Breaking someone's hold without recording whose would be the quiet kind of damage.
    expect(forced.brokeHold?.machine).toBe("laptop");
  });
});
