/**
 * Governance gate — the spec's safety boundary over autonomous evolution.
 *
 * The model's appraisal signal is a *proposal*. Before anything is applied, the
 * gate decides which proposed mutations are admissible. Clamping handles range;
 * the gate handles policy:
 *   - unknown / non-mutable fields are rejected outright;
 *   - fields tied to hard-enforced virtues are never mutable at runtime;
 *   - per-step drift is bounded (anti-runaway, anti-self-reinforcement);
 *   - in `locked` mode, only human-actor mutations pass.
 *
 * Nothing here is a black box: every decision yields an auditable verdict.
 */

import type { EnvelopeLookup } from "./envelopes.js";
import type { ProposedMutation } from "./appraisal.js";

export type ImprovementMode = "locked" | "suggesting" | "autonomous";

export interface GovernanceConfig {
  mode: ImprovementMode;
  /** Max absolute delta admitted per step (drift guard). Default 0.15. */
  maxStepDelta: number;
}

export const DEFAULT_GOVERNANCE: GovernanceConfig = {
  mode: "locked",
  maxStepDelta: 0.15,
};

export interface Verdict {
  field: string;
  admitted: boolean;
  /** Delta after drift-bounding (still subject to envelope clamp downstream). */
  delta: number;
  reason: string;
}

export interface GovernanceDecision {
  verdicts: Verdict[];
  admitted: ProposedMutation[];
  rejected: Verdict[];
}

export function governMutations(
  proposals: ProposedMutation[],
  env: EnvelopeLookup,
  cfg: GovernanceConfig = DEFAULT_GOVERNANCE,
): GovernanceDecision {
  const verdicts: Verdict[] = [];

  for (const p of proposals) {
    const v = judge(p, env, cfg);
    verdicts.push(v);
  }

  const admitted = verdicts
    .filter((v) => v.admitted)
    .map((v) => ({ field: v.field, delta: v.delta, reason: v.reason }));
  const rejected = verdicts.filter((v) => !v.admitted);
  return { verdicts, admitted, rejected };
}

function judge(
  p: ProposedMutation,
  env: EnvelopeLookup,
  cfg: GovernanceConfig,
): Verdict {
  // Autonomous evolution is only ever allowed for state-envelope fields.
  if (!(p.field in env.envelopes)) {
    return { field: p.field, admitted: false, delta: 0, reason: `not a mutable envelope field` };
  }

  // A trait backing a hard-enforced virtue is immutable at runtime.
  const traitName = p.field.startsWith("traits.") ? p.field.slice("traits.".length) : null;
  if (traitName && env.hardEnforcedVirtues.includes(traitName)) {
    return { field: p.field, admitted: false, delta: 0, reason: `field backs a hard-enforced virtue` };
  }

  // In locked mode, the actor LLM cannot self-evolve; only human-directed
  // mutations (applied via the CLI, not the loop) change state.
  if (cfg.mode === "locked") {
    return { field: p.field, admitted: false, delta: 0, reason: `improvement_policy=locked` };
  }

  // Drift guard: bound the per-step magnitude.
  const bounded = Math.max(-cfg.maxStepDelta, Math.min(cfg.maxStepDelta, p.delta));
  const note = bounded !== p.delta ? ` (drift-bounded from ${p.delta})` : "";
  return { field: p.field, admitted: true, delta: bounded, reason: p.reason + note };
}

/**
 * Govern a QUALITATIVE self-edit (prose) by improvement_policy.mode. This is a SEPARATE
 * layer from `judge` (which governs numeric envelope mutations): qualitative edits to the
 * spec's character material are higher-stakes, so the mode means something different here —
 *   locked      → block (no proposal at all);
 *   suggesting  → queue the proposal for human review (/review), never auto-apply;
 *   autonomous  → auto-apply, still gated by consensus verifiers + the protected-path list.
 * (Envelope mutations remain reversible/clamped, so suggesting==autonomous for them — see
 * `judge`. Decoupling avoids weakening the numeric drift guard while making prose evolution
 * actually respect the posture.)
 */
export function governQualitative(mode: ImprovementMode): "block" | "queue" | "auto" {
  if (mode === "locked") return "block";
  if (mode === "autonomous") return "auto";
  return "queue"; // suggesting
}

/** Read improvement_policy.mode from frontmatter, defaulting to locked. */
export function readMode(frontmatter: Record<string, unknown>): ImprovementMode {
  const ip = frontmatter.improvement_policy as { mode?: unknown } | undefined;
  const m = ip?.mode;
  return m === "suggesting" || m === "autonomous" ? m : "locked";
}

/** v0.8: read governance.max_step_delta from frontmatter; falls back to the default. */
export function readMaxStepDelta(frontmatter: Record<string, unknown>): number {
  const g = frontmatter.governance as { max_step_delta?: unknown } | undefined;
  const v = g?.max_step_delta;
  return typeof v === "number" && v > 0 && v <= 1 ? v : DEFAULT_GOVERNANCE.maxStepDelta;
}

// ─── Agent-loop budget & stop conditions (v0.9 — spec `agent_budget`) ─────────
//
// The loop-engineering failure mode (Ralph-Wiggum / money-pit) is a loop with no
// hard stop. These are first-class, declarative caps the agent checks every step.

export type StopCondition = "goal_met" | "tool_denied" | "execution_error" | "low_confidence" | "no_progress";

export interface AgentBudgetConfig {
  maxSteps: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxWallSeconds?: number;
  stopConditions: StopCondition[];
  onExhaust: "stop" | "summarize_and_stop";
}

export const DEFAULT_AGENT_BUDGET: AgentBudgetConfig = {
  maxSteps: 20,
  stopConditions: [],
  onExhaust: "stop",
};

/** Per-1M-token USD prices (input+output averaged) for cost estimation. Best-effort. */
export const MODEL_PRICES_PER_MTOK: Record<string, number> = {
  "command-a": 5, "command-r-plus": 5, "command-r": 0.6,
  "gpt-5": 7, "gpt-4o": 5, "claude-opus": 18, "claude-sonnet": 9, "claude-haiku": 2,
  "gemini-2.5-pro": 5, "deepseek": 0.4, "qwen": 0.2, "llama": 0.2, "default": 3,
};

export function estimateCostUsd(model: string, tokens: number): number {
  const key = Object.keys(MODEL_PRICES_PER_MTOK).find((k) => k !== "default" && model.toLowerCase().includes(k));
  const price = MODEL_PRICES_PER_MTOK[key ?? "default"];
  return (tokens / 1_000_000) * price;
}

export interface AgentBudgetSpent {
  steps: number;
  tokens: number;
  costUsd: number;
  wallSeconds: number;
  deniedCount: number;
  errorCount: number;
  /** Net progress signal since last step (0 = stalled). */
  progress: number;
  /** The model's last reported confidence in [0,1], if any. */
  confidence?: number;
  /** True if the model signalled completion (finish). */
  goalMet?: boolean;
}

export interface BudgetVerdict {
  field: string;
  exceeded: boolean;
  value: number;
  limit: number | null;
  reason: string;
}

export interface BudgetCheck {
  verdicts: BudgetVerdict[];
  shouldStop: boolean;
  stopReason: string | null;
}

/** Decide whether the agent loop must halt, given what it has spent so far. */
export function checkAgentBudget(spent: AgentBudgetSpent, budget: AgentBudgetConfig = DEFAULT_AGENT_BUDGET): BudgetCheck {
  const verdicts: BudgetVerdict[] = [];
  const cap = (field: string, value: number, limit: number | undefined): boolean => {
    const exceeded = typeof limit === "number" && value >= limit;
    verdicts.push({ field, exceeded, value, limit: limit ?? null, reason: exceeded ? `${field} cap reached (${value} ≥ ${limit})` : `${field} ok` });
    return exceeded;
  };

  let stopReason: string | null = null;
  if (cap("steps", spent.steps, budget.maxSteps)) stopReason ??= "max_steps";
  if (cap("tokens", spent.tokens, budget.maxTokens)) stopReason ??= "max_tokens";
  if (cap("cost_usd", Number(spent.costUsd.toFixed(4)), budget.maxCostUsd)) stopReason ??= "max_cost_usd";
  if (cap("wall_seconds", Math.floor(spent.wallSeconds), budget.maxWallSeconds)) stopReason ??= "max_wall_seconds";

  // Declarative stop-conditions (checked only if listed).
  const sc = budget.stopConditions;
  if (sc.includes("goal_met") && spent.goalMet) stopReason ??= "goal_met";
  if (sc.includes("tool_denied") && spent.deniedCount > 0) stopReason ??= "tool_denied";
  if (sc.includes("execution_error") && spent.errorCount > 0) stopReason ??= "execution_error";
  if (sc.includes("low_confidence") && typeof spent.confidence === "number" && spent.confidence < 0.2) stopReason ??= "low_confidence";
  if (sc.includes("no_progress") && spent.steps > 1 && spent.progress === 0) stopReason ??= "no_progress";

  return { verdicts, shouldStop: stopReason !== null, stopReason };
}

/** Read the spec `agent_budget` block from frontmatter; falls back to the default. */
export function readAgentBudget(frontmatter: Record<string, unknown>): AgentBudgetConfig {
  const b = frontmatter.agent_budget as Partial<Record<string, unknown>> | undefined;
  if (!b) return { ...DEFAULT_AGENT_BUDGET };
  const num = (v: unknown): number | undefined => (typeof v === "number" && v > 0 ? v : undefined);
  const conds = Array.isArray(b.stop_conditions)
    ? (b.stop_conditions.filter((c): c is StopCondition =>
        ["goal_met", "tool_denied", "execution_error", "low_confidence", "no_progress"].includes(c as string)))
    : [];
  return {
    maxSteps: num(b.max_steps) ?? DEFAULT_AGENT_BUDGET.maxSteps,
    maxTokens: num(b.max_tokens),
    maxCostUsd: typeof b.max_cost_usd === "number" && b.max_cost_usd >= 0 ? b.max_cost_usd : undefined,
    maxWallSeconds: num(b.max_wall_seconds),
    stopConditions: conds,
    onExhaust: b.on_exhaust === "summarize_and_stop" ? "summarize_and_stop" : "stop",
  };
}
