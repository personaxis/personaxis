/**
 * Plan risk assessment (J.4): evaluate an intended plan against the SAME gates the loop uses,
 * BEFORE any step runs. "Think before you act": a plan whose steps would be denied (a hard
 * limit, a protected path, an unknown tool) is rejected as a plan, so the agent never starts
 * down a path it cannot finish, and a human approving a plan (K.04) sees its risk up front.
 *
 * Pure: no LLM, no execution, no side effects. The model proposing the plan is orchestration
 * that lives in the agent loop; turning that plan into a go/no-go decision is this function,
 * and it is the piece that must be trustworthy, so it is the piece that is tested.
 */

import type { ToolSpec } from "./tools/registry.js";
import type { Policy } from "./sandbox.js";

/** One intended action in a plan. */
export interface PlanStep {
  tool: string;
  args: Record<string, unknown>;
  /** Optional human-readable intent for this step. */
  note?: string;
}

/** The gate verdict for one planned step, plus `unknown` for a tool that does not exist. */
export interface PlanRisk {
  index: number;
  tool: string;
  decision: "allow" | "ask" | "deny" | "unknown";
  reason: string;
}

export interface PlanAssessment {
  /** True when no step is blocked (`deny`/`unknown`). `ask` steps are allowed to proceed with consent. */
  ok: boolean;
  /** Per-step verdicts, in plan order. */
  risks: PlanRisk[];
  /** The steps that make the plan non-executable as written. */
  blocked: PlanRisk[];
  /** The steps that will need human approval to run. */
  needsConsent: PlanRisk[];
}

/**
 * Assess a plan by running each step's tool gate under the policy. Reuses the tools' own
 * gates, so the plan is judged by exactly the rules the loop will enforce at execution time.
 */
export function assessPlan(steps: PlanStep[], tools: ToolSpec[], policy: Policy): PlanAssessment {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const risks: PlanRisk[] = steps.map((s, index) => {
    const tool = byName.get(s.tool);
    if (!tool) return { index, tool: s.tool, decision: "unknown", reason: `no such tool '${s.tool}'` };
    const v = tool.gate(s.args, policy);
    return { index, tool: s.tool, decision: v.decision, reason: v.reason };
  });
  const blocked = risks.filter((r) => r.decision === "deny" || r.decision === "unknown");
  const needsConsent = risks.filter((r) => r.decision === "ask");
  return { ok: blocked.length === 0, risks, blocked, needsConsent };
}
