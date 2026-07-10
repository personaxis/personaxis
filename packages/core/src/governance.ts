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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { resolveField, type EnvelopeLookup } from "./envelopes.js";
import type { ProposedMutation } from "./appraisal.js";

export type ImprovementMode = "locked" | "suggesting" | "autonomous";

export interface GovernanceConfig {
  mode: ImprovementMode;
  /** Max absolute delta admitted per step (drift guard). Default 0.15. */
  maxStepDelta: number;
  /**
   * True when the mutation is a deliberate human action (`state mutate
   * --actor human-operator`), not autonomous evolution. Human-directed mutations
   * bypass the mode lock and the drift bound — that is this gate's documented
   * intent ("in locked mode, only human-directed mutations pass"). Envelope
   * membership and hard-virtue immutability still apply to EVERY actor.
   */
  humanDirected?: boolean;
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

  // PA-2 (FASE 7 foundations review): compose admitted deltas PER FIELD and
  // re-bound the net to delta_max. T2 promises gate-admitted movement per
  // coordinate per tick <= delta_max; without this fold, k same-field proposals
  // each within the cap slip k*delta_max of net movement through the gate. One
  // composed mutation per field also makes Def. 8's "at most one mutation per
  // coordinate per lock-held write" true by construction. Human-directed
  // batches keep per-proposal semantics (the cap does not apply to them).
  let admitted: ProposedMutation[];
  if (cfg.humanDirected) {
    admitted = verdicts
      .filter((v) => v.admitted)
      .map((v) => ({ field: v.field, delta: v.delta, reason: v.reason }));
  } else {
    const byField = new Map<string, { delta: number; reasons: string[] }>();
    for (const v of verdicts) {
      if (!v.admitted) continue;
      const slot = byField.get(v.field) ?? { delta: 0, reasons: [] };
      slot.delta += v.delta;
      slot.reasons.push(v.reason);
      byField.set(v.field, slot);
    }
    admitted = [...byField.entries()].map(([field, slot]) => {
      const net = Math.max(-cfg.maxStepDelta, Math.min(cfg.maxStepDelta, slot.delta));
      const note =
        slot.reasons.length > 1
          ? ` (composed from ${slot.reasons.length} proposals${net !== slot.delta ? `; net drift-bounded from ${slot.delta.toFixed(4)}` : ""})`
          : "";
      return { field, delta: net, reason: slot.reasons[0] + note };
    });
  }
  const rejected = verdicts.filter((v) => !v.admitted);
  return { verdicts, admitted, rejected };
}

function judge(
  p: ProposedMutation,
  env: EnvelopeLookup,
  cfg: GovernanceConfig,
): Verdict {
  // Accept either key form (short ≤0.10 / full-dot-path 1.0) — resolve onto the
  // persona's canonical envelope key before judging.
  const field = resolveField(p.field, env.envelopes);

  // Autonomous evolution is only ever allowed for state-envelope fields.
  if (!(field in env.envelopes)) {
    return { field, admitted: false, delta: 0, reason: `not a mutable envelope field` };
  }

  // A trait backing a hard-enforced virtue is immutable at runtime — for every
  // actor, human included (change the spec, not the state, to move it).
  // v1.0: protectedFields carries the exact keys (incl. refs-derived ones);
  // legacy lookups without it fall back to the name-match rule.
  if (env.protectedFields) {
    if (env.protectedFields.includes(field)) {
      return { field, admitted: false, delta: 0, reason: `field backs a hard-enforced virtue` };
    }
  } else {
    const traitName = field.startsWith("traits.")
      ? field.slice("traits.".length)
      : field.startsWith("personality.traits.")
        ? field.slice("personality.traits.".length)
        : null;
    if (traitName && env.hardEnforcedVirtues.includes(traitName)) {
      return { field, admitted: false, delta: 0, reason: `field backs a hard-enforced virtue` };
    }
  }

  // Deliberate human mutations are not autonomous evolution: no mode lock, no
  // drift bound (the envelope clamp downstream still applies).
  if (cfg.humanDirected) {
    return { field, admitted: true, delta: p.delta, reason: p.reason };
  }

  // In locked mode, the actor LLM cannot self-evolve; only human-directed
  // mutations (applied via the CLI, not the loop) change state.
  if (cfg.mode === "locked") {
    return { field, admitted: false, delta: 0, reason: `improvement_policy=locked` };
  }

  // Drift guard: bound the per-step magnitude.
  const bounded = Math.max(-cfg.maxStepDelta, Math.min(cfg.maxStepDelta, p.delta));
  const note = bounded !== p.delta ? ` (drift-bounded from ${p.delta})` : "";
  return { field, admitted: true, delta: bounded, reason: p.reason + note };
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

const MODE_RANK: Record<ImprovementMode, number> = { locked: 0, suggesting: 1, autonomous: 2 };

function normalizeMode(m: unknown): ImprovementMode | undefined {
  if (m === "locked" || m === "suggesting" || m === "autonomous") return m;
  if (m === "auto") return "autonomous"; // legacy policy.yaml enum value
  return undefined;
}

/** Mode declared by the sibling policy.yaml, if any (undefined when absent/unreadable). */
function readPolicyMode(personaPath: string): ImprovementMode | undefined {
  try {
    const p = join(dirname(personaPath), "policy.yaml");
    if (!existsSync(p)) return undefined;
    const doc = loadYaml(readFileSync(p, "utf-8")) as
      | { improvement_policy?: { mode?: unknown } }
      | undefined;
    return normalizeMode(doc?.improvement_policy?.mode);
  } catch {
    return undefined; // a malformed policy.yaml must not crash mode resolution
  }
}

/**
 * Read the improvement mode. v1.0 precedence (SPEC.md §7.2): the INLINE
 * `improvement_policy.mode` in personaxis.md is authoritative; when a
 * `personaPath` is given, the sibling policy.yaml may only RESTRICT it — the
 * more conservative of the two wins (min-wins). Inline absent → policy.yaml
 * governs; both absent → locked.
 */
export function readMode(
  frontmatter: Record<string, unknown>,
  personaPath?: string,
): ImprovementMode {
  const ip = frontmatter.improvement_policy as { mode?: unknown } | undefined;
  const inline = normalizeMode(ip?.mode);
  if (!personaPath) return inline ?? "locked";
  const policy = readPolicyMode(personaPath);
  if (inline === undefined) return policy ?? "locked";
  if (policy === undefined) return inline;
  return MODE_RANK[policy] < MODE_RANK[inline] ? policy : inline;
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
