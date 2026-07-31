/**
 * J.4: `assessPlan` judges a plan by the same gates the loop enforces, so a plan with a denied
 * or unknown step is rejected before anything runs, and `ask` steps are surfaced as needing
 * consent rather than blocking.
 */
import { describe, it, expect } from "vitest";
import { assessPlan, type PlanStep } from "../src/planner.js";
import { BUILTIN_TOOLS } from "../src/tools/builtin/index.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";
import type { ToolSpec } from "../src/tools/registry.js";

const READ_CLASS = { writesFiles: false, network: false, destructive: false, escapesWorkspace: false };

// A synthetic tool whose gate always denies: stands in for a hard-limit / protected action,
// so the test does not couple to the sandbox's internal command classification.
const denyTool: ToolSpec = {
  name: "danger",
  description: "always denied",
  category: "shell",
  parameters: { type: "object", properties: {}, additionalProperties: true },
  isReadOnly: false,
  isConcurrencySafe: false,
  gate: () => ({ decision: "deny", reason: "hard limit", class: { ...READ_CLASS, destructive: true } }),
  execute: async () => "",
};

const tools = [...BUILTIN_TOOLS, denyTool];

describe("assessPlan (J.4)", () => {
  it("passes a plan of allowed steps", () => {
    const plan: PlanStep[] = [
      { tool: "read_file", args: { path: "src/index.ts" } },
      { tool: "finish", args: { summary: "done" } },
    ];
    const a = assessPlan(plan, tools, DEFAULT_POLICY);
    expect(a.ok).toBe(true);
    expect(a.blocked).toEqual([]);
  });

  it("rejects a plan the moment one step would be denied (a hard limit)", () => {
    const plan: PlanStep[] = [
      { tool: "read_file", args: { path: "src/index.ts" } },
      { tool: "danger", args: {} },
    ];
    const a = assessPlan(plan, tools, DEFAULT_POLICY);
    expect(a.ok).toBe(false);
    expect(a.blocked.map((b) => b.index)).toEqual([1]);
    expect(a.blocked[0].reason).toBe("hard limit");
  });

  it("rejects an unknown tool as unrunnable, not as a policy question", () => {
    const a = assessPlan([{ tool: "teleport", args: {} }], tools, DEFAULT_POLICY);
    expect(a.ok).toBe(false);
    expect(a.blocked[0].decision).toBe("unknown");
  });

  it("surfaces ask-steps as needing consent without blocking the plan", () => {
    // A read that escapes the workspace gates to `ask` under a non-full-access policy.
    const plan: PlanStep[] = [{ tool: "read_file", args: { path: "../outside.txt" } }];
    const a = assessPlan(plan, tools, { ...DEFAULT_POLICY, sandbox: "workspace-write", workspaceRoot: "/work" });
    expect(a.ok).toBe(true);
    expect(a.needsConsent.length).toBe(1);
    expect(a.needsConsent[0].decision).toBe("ask");
  });
});
