/**
 * K.07: the watchdog aborts a run that breaches its wall-clock or cost/token ceiling, records
 * the abort in the forensic log, trips the AbortSignal, and does so at most once. The clock is
 * injected so "time passed" is deterministic.
 */
import { describe, it, expect, vi } from "vitest";
import { Watchdog } from "../src/security/watchdog.js";
import { ForensicLog } from "../src/security/forensic-log.js";

describe("watchdog (K.07)", () => {
  it("aborts when the wall-clock limit is breached, and records it", () => {
    let t = 1_000;
    const forensic = new ForensicLog();
    const onAbort = vi.fn();
    const w = new Watchdog({ maxWallMs: 5_000 }, { now: () => t, onAbort, forensic });

    t = 4_000; // 3s elapsed, under limit
    w.check();
    expect(w.aborted).toBe(false);

    t = 6_500; // 5.5s elapsed, over limit
    w.check();
    expect(w.aborted).toBe(true);
    expect(w.abortReason).toMatch(/wall-clock/);
    expect(w.signal.aborted).toBe(true);
    expect(onAbort).toHaveBeenCalledOnce();
    // The abort is witnessed in the immutable audit.
    expect(forensic.entries().at(-1)).toMatchObject({ kind: "abort" });
  });

  it("aborts on the cost ceiling", () => {
    let cost = 0;
    const w = new Watchdog({ maxCostUsd: 1.0 }, { spend: () => ({ costUsd: cost, tokens: 0 }), onAbort: () => {} });
    cost = 0.5;
    w.check();
    expect(w.aborted).toBe(false);
    cost = 1.25;
    w.check();
    expect(w.aborted).toBe(true);
    expect(w.abortReason).toMatch(/cost limit/);
  });

  it("fires at most once even if checked again after breach", () => {
    let t = 0;
    const onAbort = vi.fn();
    const w = new Watchdog({ maxWallMs: 10 }, { now: () => t, onAbort });
    t = 50;
    w.check();
    w.check();
    w.check();
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("with no limits set, start() is a no-op and it never aborts", () => {
    const w = new Watchdog({}, { onAbort: () => {} });
    w.start();
    w.check();
    expect(w.aborted).toBe(false);
    w.stop();
  });

  it("the real timer fires the check out of band", async () => {
    let t = 0;
    const onAbort = vi.fn();
    const w = new Watchdog({ maxWallMs: 20, pollMs: 5 }, { now: () => t, onAbort });
    w.start();
    t = 100; // time jumps past the limit
    await new Promise((r) => setTimeout(r, 30)); // let the poll fire
    w.stop();
    expect(onAbort).toHaveBeenCalled();
  });
});
