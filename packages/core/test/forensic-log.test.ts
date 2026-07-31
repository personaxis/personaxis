/**
 * K.10: the forensic log is append-only, its records are frozen, and any alteration to a
 * loaded chain is detectable at a specific position.
 */
import { describe, it, expect } from "vitest";
import { ForensicLog, verifyForensicChain, type ForensicRecord } from "../src/security/forensic-log.js";

describe("forensic log (K.10)", () => {
  it("seals frozen, hash-linked records and verifies clean", () => {
    const log = new ForensicLog();
    log.append({ kind: "tool-call", tool: "run_command", decision: "allow", executed: true, ok: true });
    log.append({ kind: "tool-call", tool: "write_file", decision: "deny", executed: false, reason: "hard limit" });
    const rows = log.entries();
    expect(rows).toHaveLength(2);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(rows[0].prevHash).toBe("");
    expect(rows[1].prevHash).toBe(rows[0].hash); // chained
    expect(rows[0].seq).toBe(0);
    expect(log.verify()).toBe(-1);
  });

  it("detects tampering at the exact record, on a loaded copy", () => {
    const log = new ForensicLog();
    log.append({ kind: "tool-call", tool: "a", decision: "allow", executed: true });
    log.append({ kind: "tool-call", tool: "b", decision: "allow", executed: true });
    log.append({ kind: "tool-call", tool: "c", decision: "deny", executed: false });
    // Simulate loading from disk and someone flipping a denial into an execution.
    const loaded: ForensicRecord[] = log.entries().map((r) => ({ ...r }));
    loaded[2] = { ...loaded[2], executed: true, decision: "allow" };
    expect(verifyForensicChain(loaded)).toBe(2);
  });

  it("a sink that throws never breaks the caller", () => {
    const log = new ForensicLog(() => {
      throw new Error("disk full");
    });
    expect(() => log.append({ kind: "abort", reason: "x" })).not.toThrow();
    expect(log.entries()).toHaveLength(1);
  });
});
