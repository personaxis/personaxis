/**
 * K.02: isolation resolution is availability-aware. The key property is HONESTY: a native
 * primitive that is not installed degrades to `none` with a note, never to a command that would
 * ENOENT, and never silently to full access. The OS and the PATH check are injected so this is
 * deterministic on any machine (David's is Windows).
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolveIsolation, describeIsolation } from "../src/security/isolation.js";
import { DEFAULT_POLICY, wrapCommand } from "../src/sandbox.js";

const policy = (over = {}) => ({ ...DEFAULT_POLICY, workspaceRoot: "/work", ...over });
const yes = () => true;
const no = () => false;

describe("OS isolation (K.02)", () => {
  it("wraps with bubblewrap on Linux WHEN bwrap is available", () => {
    const r = resolveIsolation("npm test", policy(), { os: "linux", hasBinary: yes });
    expect(r.backend).toBe("bubblewrap");
    expect(r.enforced).toBe(true);
    expect(r.command).toBe("bwrap");
    expect(r.args.join(" ")).toContain("npm test");
  });

  it("degrades HONESTLY to none on Linux when bwrap is MISSING (no ENOENT, no fake sandbox)", () => {
    const r = resolveIsolation("npm test", policy(), { os: "linux", hasBinary: no });
    expect(r.backend).toBe("none");
    expect(r.enforced).toBe(false);
    expect(r.note).toMatch(/bwrap not found/);
    // The command must still be runnable (via the shell), not a bwrap that does not exist.
    expect(r.command).not.toBe("bwrap");
  });

  it("wraps with Seatbelt on macOS when sandbox-exec is available, degrades otherwise", () => {
    expect(resolveIsolation("ls", policy(), { os: "darwin", hasBinary: yes }).backend).toBe("seatbelt");
    expect(resolveIsolation("ls", policy(), { os: "darwin", hasBinary: no }).backend).toBe("none");
  });

  it("Windows is honestly none (no reachable kernel primitive), never enforced", () => {
    const r = resolveIsolation("dir", policy(), { os: "win32", hasBinary: yes });
    expect(r.backend).toBe("none");
    expect(r.enforced).toBe(false);
  });

  it("danger-full-access never wraps, on any OS", () => {
    for (const os of ["linux", "darwin", "win32"] as const) {
      expect(resolveIsolation("x", policy({ sandbox: "danger-full-access" }), { os, hasBinary: yes }).backend).toBe("none");
    }
  });

  it("read-only on macOS denies all writes in the profile", () => {
    const r = resolveIsolation("touch f", policy({ sandbox: "read-only" }), { os: "darwin", hasBinary: yes });
    expect(r.args.join(" ")).toContain("(deny file-write*)");
    expect(r.args.join(" ")).not.toContain("allow file-write*");
  });

  it("describeIsolation distinguishes kernel-enforced from policy-only", () => {
    expect(describeIsolation(resolveIsolation("x", policy(), { os: "linux", hasBinary: yes }))).toMatch(/kernel-enforced/);
    expect(describeIsolation(resolveIsolation("x", policy(), { os: "win32", hasBinary: yes }))).toMatch(/policy-only/);
  });

  it("wrapCommand delegates and stays within its lenient contract", () => {
    const w = wrapCommand("npm test", policy());
    expect(["seatbelt", "bubblewrap", "none"]).toContain(w.sandbox);
    expect(w.args.join(" ")).toContain("npm test");
  });

  // Real enforcement: only meaningful on a POSIX box that actually has the primitive. Skipped on
  // Windows (David's machine) and anywhere the binary is absent, rather than faking a pass.
  const bwrap = process.platform === "linux" && existsSync("/usr/bin/bwrap");
  it.skipIf(!bwrap)("[linux+bwrap] a real bubblewrap wrap is produced and points at the workspace", () => {
    const r = resolveIsolation("echo hi", policy({ workspaceRoot: process.cwd() }), {});
    expect(r.backend).toBe("bubblewrap");
    expect(r.args).toContain(process.cwd());
  });
});
