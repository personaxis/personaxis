/**
 * Human-in-the-loop risk matrix (K.04): decide allow / ask / deny for a tool call from more than
 * the command's static class. The sandbox gate is coarse (it knows "this writes a file"); consent
 * adds the dimensions that turn a routine action into a dangerous one: the sandbox posture in
 * effect, whether the surrounding context is tainted by injection (an untrusted tool output that
 * may be steering the agent), whether the action is irreversible, and whether it touches sensitive
 * data.
 *
 * The one rule that makes this safe: consent can only TIGHTEN. It combines with the sandbox verdict
 * by taking the stricter of the two, so it can turn an allow into an ask, or an ask into a deny,
 * but never the reverse. Defense in depth, not a second, weaker gate.
 *
 * It also answers the fatigue problem without ceding control: a whole PLAN is assessed at once
 * (approve the batch, not every step), and an explicit "always" for a pattern is remembered so an
 * identical safe action does not re-ask. Pure and deterministic; the loop and the approval broker
 * consume it.
 */

import type { CommandClass } from "../sandbox.js";

export type ConsentDecision = "allow" | "ask" | "deny";
export type SandboxPosture = "read-only" | "workspace-write" | "danger-full-access";
export type ContextTaint = "clean" | "suspicious" | "malicious";

export interface RiskFactors {
  /** The command's static classification (from `classifyCommand`). */
  klass: CommandClass;
  /** The sandbox posture in effect for this session. */
  sandbox: SandboxPosture;
  /** Taint of the context that produced this call (max injection verdict of prior tool outputs). */
  taint?: ContextTaint;
  /** True when the action reads or moves secrets/credentials (fed by K.09). */
  sensitiveData?: boolean;
}

export interface RiskAssessment {
  decision: ConsentDecision;
  /** Informational risk magnitude (0..1+); the decision is rule-based, not a threshold on this. */
  score: number;
  /** True when the action cannot be cleanly undone (destructive, or escapes the workspace). */
  irreversible: boolean;
  reasons: string[];
}

const STRICTNESS: Record<ConsentDecision, number> = { allow: 0, ask: 1, deny: 2 };

/** The stricter (more restrictive) of two decisions. */
export function stricter(a: ConsentDecision, b: ConsentDecision): ConsentDecision {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

const TAINT_RANK: Record<ContextTaint, number> = { clean: 0, suspicious: 1, malicious: 2 };

/** The higher (more tainted) of two context-taint levels; taint only ever accumulates in a run. */
export function maxTaint(a: ContextTaint, b: ContextTaint): ContextTaint {
  return TAINT_RANK[b] > TAINT_RANK[a] ? b : a;
}

/**
 * Score a tool call's risk and decide allow / ask / deny.
 *
 * Hard floor: a destructive or workspace-escaping action while the context is MALICIOUS-tainted is
 * the textbook indirect-injection attack (untrusted content telling the agent to delete or exfil);
 * it is DENIED outright, regardless of sandbox posture. Otherwise:
 *   - "hard ask" reasons always ask, even under danger-full-access (the user opted into low
 *     friction, not into skipping confirmation for an irreversible or tainted action);
 *   - "soft ask" reasons ask unless the posture is danger-full-access (the user accepted the risk).
 */
export function scoreRisk(f: RiskFactors): RiskAssessment {
  const reasons: string[] = [];
  const taint = f.taint ?? "clean";
  const irreversible = f.klass.destructive || f.klass.escapesWorkspace;
  let score = 0;

  // Hard deny floor: irreversible action under a malicious-tainted context.
  if (taint === "malicious" && (f.klass.destructive || f.klass.escapesWorkspace || f.klass.network)) {
    return {
      decision: "deny",
      score: 1,
      irreversible,
      reasons: [`context is injection-tainted (malicious) and the action is ${f.klass.destructive ? "destructive" : f.klass.network ? "network egress" : "escaping the workspace"}`],
    };
  }

  let hardAsk = false;
  let softAsk = false;

  if (f.klass.destructive) { hardAsk = true; score += 0.5; reasons.push("destructive (irreversible)"); }
  if (f.sensitiveData) { hardAsk = true; score += 0.4; reasons.push("touches sensitive data"); }
  if (taint === "malicious") { hardAsk = true; score += 0.6; reasons.push("context injection-tainted (malicious)"); }
  else if (taint === "suspicious") { hardAsk = true; score += 0.4; reasons.push("context injection-tainted (suspicious)"); }
  if (f.klass.escapesWorkspace) { hardAsk = true; score += 0.3; reasons.push("escapes the workspace"); }
  if (f.klass.network) { softAsk = true; score += 0.3; reasons.push("network access"); }
  if (f.klass.writesFiles) { softAsk = true; score += 0.2; reasons.push("writes files"); }

  let decision: ConsentDecision;
  if (hardAsk) decision = "ask";
  else if (softAsk && f.sandbox !== "danger-full-access") decision = "ask";
  else decision = "allow";

  if (decision === "allow" && reasons.length === 0) reasons.push("read-only / no risk factors");
  return { decision, score: Number(score.toFixed(3)), irreversible, reasons };
}

/**
 * Combine consent with the sandbox's own verdict: take the stricter. Consent never loosens a deny
 * and never downgrades an ask to allow; it only ever adds restriction.
 */
export function tightenVerdict(sandboxDecision: ConsentDecision, factors: RiskFactors): RiskAssessment {
  const a = scoreRisk(factors);
  const decision = stricter(sandboxDecision, a.decision);
  const reasons = decision === sandboxDecision && sandboxDecision !== a.decision
    ? [`sandbox: ${sandboxDecision}`, ...a.reasons]
    : a.reasons;
  return { ...a, decision, reasons };
}

/**
 * Remembered "always allow" patterns, so an identical safe action does not re-ask. A pattern is a
 * literal command prefix; matching is prefix-based to keep it conservative (never a broad regex the
 * user did not intend).
 */
export class ConsentMemory {
  private readonly patterns = new Set<string>();

  remember(pattern: string): void {
    const p = pattern.trim();
    if (p) this.patterns.add(p);
  }

  /** True when a remembered pattern is a prefix of `command`. */
  covers(command: string): boolean {
    const c = command.trim();
    for (const p of this.patterns) if (c === p || c.startsWith(p + " ") || c.startsWith(p)) return true;
    return false;
  }

  get size(): number {
    return this.patterns.size;
  }
}

export interface PlanConsent {
  decision: ConsentDecision;
  perStep: RiskAssessment[];
  /** Index of the first step that forced a deny, if any. */
  blockedAt?: number;
}

/**
 * Assess a whole plan's steps at once, so the human approves the BATCH rather than every step (the
 * fatigue fix, tied to the J.4 plan phase). The plan is denied if any step denies; it asks if any
 * step asks; otherwise it flows. One decision covers the run.
 */
export function assessPlanConsent(steps: RiskFactors[]): PlanConsent {
  const perStep = steps.map(scoreRisk);
  const blockedAt = perStep.findIndex((s) => s.decision === "deny");
  if (blockedAt >= 0) return { decision: "deny", perStep, blockedAt };
  const decision: ConsentDecision = perStep.some((s) => s.decision === "ask") ? "ask" : "allow";
  return { decision, perStep };
}
