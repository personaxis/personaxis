/**
 * K.04: the HITL risk matrix. Consent scores a call from posture × taint × reversibility ×
 * sensitivity and can only TIGHTEN the sandbox verdict. The load-bearing guarantee: a destructive
 * or escaping action while the context is injection-tainted is DENIED, regardless of posture.
 */
import { describe, it, expect } from "vitest";
import {
  scoreRisk,
  tightenVerdict,
  stricter,
  maxTaint,
  ConsentMemory,
  assessPlanConsent,
  type RiskFactors,
} from "../src/security/consent.js";
import type { CommandClass } from "../src/sandbox.js";

const K = (over: Partial<CommandClass> = {}): CommandClass => ({
  writesFiles: false,
  network: false,
  destructive: false,
  escapesWorkspace: false,
  ...over,
});

describe("scoreRisk", () => {
  it("allows a read-only action with no risk factors", () => {
    const r = scoreRisk({ klass: K(), sandbox: "workspace-write" });
    expect(r.decision).toBe("allow");
  });

  it("HARD DENY: destructive action under a malicious-tainted context, any posture", () => {
    for (const sandbox of ["read-only", "workspace-write", "danger-full-access"] as const) {
      const r = scoreRisk({ klass: K({ destructive: true }), sandbox, taint: "malicious" });
      expect(r.decision).toBe("deny");
      expect(r.irreversible).toBe(true);
    }
  });

  it("HARD DENY: network egress under a malicious-tainted context (exfiltration path)", () => {
    const r = scoreRisk({ klass: K({ network: true }), sandbox: "danger-full-access", taint: "malicious" });
    expect(r.decision).toBe("deny");
  });

  it("a destructive action always ASKS, even under danger-full-access", () => {
    const r = scoreRisk({ klass: K({ destructive: true }), sandbox: "danger-full-access" });
    expect(r.decision).toBe("ask");
  });

  it("a plain file write ASKS under workspace-write but flows under danger-full-access (opted in)", () => {
    expect(scoreRisk({ klass: K({ writesFiles: true }), sandbox: "workspace-write" }).decision).toBe("ask");
    expect(scoreRisk({ klass: K({ writesFiles: true }), sandbox: "danger-full-access" }).decision).toBe("allow");
  });

  it("sensitive-data access asks regardless of posture", () => {
    const r = scoreRisk({ klass: K(), sandbox: "danger-full-access", sensitiveData: true });
    expect(r.decision).toBe("ask");
  });

  it("a suspicious taint escalates an otherwise-quiet action to ask", () => {
    const r = scoreRisk({ klass: K({ writesFiles: true }), sandbox: "danger-full-access", taint: "suspicious" });
    expect(r.decision).toBe("ask");
  });
});

describe("tightenVerdict (never loosens)", () => {
  it("keeps a sandbox deny even if consent would allow", () => {
    const r = tightenVerdict("deny", { klass: K(), sandbox: "workspace-write" });
    expect(r.decision).toBe("deny");
  });

  it("escalates a sandbox allow to deny when the context is malicious-tainted + destructive", () => {
    const r = tightenVerdict("allow", { klass: K({ destructive: true }), sandbox: "danger-full-access", taint: "malicious" });
    expect(r.decision).toBe("deny");
  });

  it("escalates a sandbox allow to ask for a destructive action", () => {
    const r = tightenVerdict("allow", { klass: K({ destructive: true }), sandbox: "danger-full-access" });
    expect(r.decision).toBe("ask");
  });
});

describe("stricter / maxTaint", () => {
  it("stricter picks the more restrictive decision", () => {
    expect(stricter("allow", "ask")).toBe("ask");
    expect(stricter("deny", "allow")).toBe("deny");
    expect(stricter("ask", "ask")).toBe("ask");
  });
  it("maxTaint only accumulates", () => {
    expect(maxTaint("clean", "suspicious")).toBe("suspicious");
    expect(maxTaint("malicious", "clean")).toBe("malicious");
    expect(maxTaint("suspicious", "malicious")).toBe("malicious");
  });
});

describe("ConsentMemory (always-allow by pattern)", () => {
  it("covers a command that a remembered prefix matches", () => {
    const m = new ConsentMemory();
    m.remember("npm test");
    expect(m.covers("npm test")).toBe(true);
    expect(m.covers("npm test -- --watch")).toBe(true);
    expect(m.covers("rm -rf /")).toBe(false);
  });
});

describe("assessPlanConsent (batch)", () => {
  const steps: RiskFactors[] = [
    { klass: K(), sandbox: "workspace-write" },
    { klass: K({ writesFiles: true }), sandbox: "workspace-write" },
  ];

  it("asks once for a plan whose steps are safe-or-ask", () => {
    const p = assessPlanConsent(steps);
    expect(p.decision).toBe("ask");
    expect(p.perStep).toHaveLength(2);
  });

  it("denies the whole plan when any step must deny, naming the step", () => {
    const p = assessPlanConsent([
      ...steps,
      { klass: K({ destructive: true }), sandbox: "read-only", taint: "malicious" },
    ]);
    expect(p.decision).toBe("deny");
    expect(p.blockedAt).toBe(2);
  });

  it("allows a plan of only read-only steps", () => {
    const p = assessPlanConsent([{ klass: K(), sandbox: "workspace-write" }]);
    expect(p.decision).toBe("allow");
  });
});
