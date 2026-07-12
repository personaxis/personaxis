/**
 * FR.7 / FR.8 / FR.10, the platform hardening trio:
 *   registry flags + schema arg validation, permissions v2 (writable roots,
 *   protected subpaths, granular approvals, profiles), the approval FSM, and
 *   tool-call repair.
 */
import { describe, it, expect } from "vitest";
import {
  TOOLS,
  toolByName,
  validateToolArgs,
  evaluateFileWrite,
  evaluateCommand,
  policyFromProfile,
  isProtectedPath,
  DEFAULT_POLICY,
  ApprovalBroker,
  repairToolArgs,
  type Policy,
} from "../src/index.js";

// ── FR.7: registry flags + validation ────────────────────────────────────────

describe("FR.7 tools registry v2", () => {
  it("read-only tools are concurrency-safe; writers are neither", () => {
    for (const name of ["read_file", "list_dir", "finish"]) {
      const t = toolByName(name)!;
      expect(t.isReadOnly, name).toBe(true);
      expect(t.isConcurrencySafe, name).toBe(true);
    }
    for (const name of ["run_command", "write_file", "edit_file"]) {
      const t = toolByName(name)!;
      expect(t.isReadOnly, name).toBe(false);
      expect(t.isConcurrencySafe, name).toBe(false);
    }
    expect(TOOLS.every((t) => typeof t.isReadOnly === "boolean")).toBe(true);
  });

  it("validateToolArgs rejects missing/unknown/mistyped args BEFORE the gate", () => {
    const write = toolByName("write_file")!;
    expect(validateToolArgs(write, { path: "a.txt", content: "x" })).toEqual([]);
    expect(validateToolArgs(write, { path: "a.txt" })).toEqual(["missing required arg 'content'"]);
    expect(validateToolArgs(write, { path: 42 as unknown as string, content: "x" })[0]).toContain("must be string");
    expect(validateToolArgs(write, { path: "a", content: "x", extra: 1 })[0]).toContain("unknown arg");
  });
});

// ── FR.8: permissions v2 ──────────────────────────────────────────────────────

describe("FR.8 permissions v2", () => {
  // Absolute-path prefix that is a real absolute path on the running OS, so the
  // "outside every writable root" checks behave the same on POSIX and Windows.
  const ABS = process.platform === "win32" ? "C:/" : "/";
  const base: Policy = { ...DEFAULT_POLICY, workspaceRoot: `${ABS}ws` };

  it("protected subpaths deny even when otherwise writable, allow-list cannot override", () => {
    const policy: Policy = { ...base, allow: [".*"] };
    for (const p of [".git/hooks/pre-commit", ".personaxis/personaxis.md", ".personaxis/state.json"]) {
      const v = evaluateFileWrite(p, policy);
      expect(v.decision, p).toBe("deny");
      expect(v.reason).toContain("protected subpath");
    }
    expect(isProtectedPath(".git/hooks/post-merge", policy)).toBe(true);
    expect(isProtectedPath("src/app.ts", policy)).toBe(false);
    // A normal write still flows.
    expect(evaluateFileWrite("src/app.ts", policy).decision).toBe("allow");
  });

  it("writableRoots extend workspace-write beyond the workspaceRoot", () => {
    const policy: Policy = { ...base, writableRoots: [`${ABS}out`] };
    expect(evaluateFileWrite(`${ABS}out/bundle.js`, policy).decision).not.toBe("deny");
    expect(evaluateFileWrite(`${ABS}elsewhere/x.txt`, policy).decision).toBe("deny");
    // Protected subpaths hold inside EVERY root.
    expect(evaluateFileWrite(`${ABS}out/.git/hooks/x`, policy).decision).toBe("deny");
  });

  it("granular approvals: strictest matching category wins over the global knob", () => {
    const policy: Policy = { ...base, approval: "never", approvals: { network: "untrusted" } };
    // Network command → per-category override forces ask despite approval=never.
    expect(evaluateCommand("curl https://example.com", policy).decision).toBe("ask");
    // Plain write keeps the permissive global.
    expect(evaluateCommand("touch a.txt", policy).decision).toBe("allow");
  });

  it("named profiles map to the four postures", () => {
    expect(policyFromProfile("strict").sandbox).toBe("read-only");
    expect(policyFromProfile("standard").approval).toBe("on-request");
    expect(policyFromProfile("trusted").approval).toBe("on-failure");
    expect(policyFromProfile("yolo").sandbox).toBe("danger-full-access");
    expect(policyFromProfile("strict", { workspaceRoot: "C:/x" }).workspaceRoot).toBe("C:/x");
  });
});

// ── FR.10: approval FSM ───────────────────────────────────────────────────────

describe("FR.10 approval broker (request → deliver → await → gate)", () => {
  it("resolves when any surface decides; double-decide is rejected", async () => {
    const broker = new ApprovalBroker();
    let delivered = "";
    const { requestId, decision } = broker.request("run_command", { command: "rm x" }, "risky", {
      onRequest: (r) => (delivered = r.requestId),
    });
    expect(delivered).toBe(requestId);
    expect(broker.pending()).toHaveLength(1);
    expect(broker.decide(requestId, "allow")).toBe(true);
    expect(await decision).toBe("allow");
    expect(broker.decide(requestId, "deny")).toBe(false); // already gated
    expect(broker.pending()).toHaveLength(0);
  });

  it("expires FAIL-CLOSED to deny", async () => {
    const broker = new ApprovalBroker();
    const { decision } = broker.request("write_file", {}, "slow human", { timeoutMs: 20 });
    expect(await decision).toBe("deny");
  });
});

// ── FR.10: tool-call repair ───────────────────────────────────────────────────

describe("FR.10 tool-call repair (OpenClaw port)", () => {
  it("passes valid JSON through unrepaired", () => {
    const r = repairToolArgs('{"path": "a.txt"}');
    expect(r).toMatchObject({ ok: true, repaired: false, value: { path: "a.txt" } });
  });

  it("strips code fences and surrounding prose", () => {
    expect(repairToolArgs('```json\n{"a": 1}\n```').value).toEqual({ a: 1 });
    expect(repairToolArgs('Here are the args: {"a": 1}, done!').value).toEqual({ a: 1 });
  });

  it("repairs quotes, keys and trailing commas", () => {
    expect(repairToolArgs("{'path': 'a.txt'}").value).toEqual({ path: "a.txt" });
    expect(repairToolArgs('{path: "a.txt"}').value).toEqual({ path: "a.txt" });
    expect(repairToolArgs('{"a": 1,}').value).toEqual({ a: 1 });
  });

  it("closes truncated objects (mid-string and mid-object)", () => {
    expect(repairToolArgs('{"path": "a.txt", "content": "hello wor').value).toMatchObject({
      path: "a.txt",
      content: "hello wor",
    });
    expect(repairToolArgs('{"a": {"b": 1}').value).toEqual({ a: { b: 1 } });
    const r = repairToolArgs('{"a": 1,');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });

  it("reports unrecoverable input honestly", () => {
    const r = repairToolArgs("not even close");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
