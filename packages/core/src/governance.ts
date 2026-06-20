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

/** Read improvement_policy.mode from frontmatter, defaulting to locked. */
export function readMode(frontmatter: Record<string, unknown>): ImprovementMode {
  const ip = frontmatter.improvement_policy as { mode?: unknown } | undefined;
  const m = ip?.mode;
  return m === "suggesting" || m === "autonomous" ? m : "locked";
}
