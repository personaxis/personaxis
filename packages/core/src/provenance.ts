/**
 * Provenance & sensitive-action gates (F3 — plan/11-security).
 *
 * The memory-poisoning literature shows that "internal state = trusted" is a
 * false assumption: untrusted content laundered through memory drives later
 * "trusted" actions (Yang et al., 2026; Dash et al., 2026). Defenses here:
 *   - rank every source by trust;
 *   - gate sensitive actions on the *provenance of their justification* — if the
 *     reasoning traces to an untrusted channel, the action is refused;
 *   - a lightweight consensus check flags contradictory memory (A-MemGuard-style).
 */

import type { ProvenanceSource } from "./appraisal.js";
import type { MemoryEntry } from "./memory.js";

/** Higher = more trusted. tool/synthesis are the poisoning-prone channels. */
export const TRUST: Record<ProvenanceSource, number> = {
  user: 3,
  internal: 2,
  synthesis: 1,
  tool: 1,
};

export type SensitiveAction =
  | "delete"
  | "external_api"
  | "credential_use"
  | "self_edit"
  | "file_write";

/** Minimum justification trust required to dispatch each sensitive action. */
export const ACTION_MIN_TRUST: Record<SensitiveAction, number> = {
  delete: 3,
  credential_use: 3,
  external_api: 2,
  self_edit: 3,
  file_write: 2,
};

export interface GateResult {
  allowed: boolean;
  action: SensitiveAction;
  minTrust: number;
  justificationTrust: number;
  reason: string;
}

/**
 * Decide whether a sensitive action may proceed given the provenance of the
 * memory/observations justifying it. The weakest link wins: a single untrusted
 * source in the justification chain caps the trust.
 */
export function sensitiveActionGate(
  action: SensitiveAction,
  justificationSources: ProvenanceSource[],
): GateResult {
  const minTrust = ACTION_MIN_TRUST[action];
  const justificationTrust =
    justificationSources.length === 0
      ? 0
      : Math.min(...justificationSources.map((s) => TRUST[s]));
  const allowed = justificationTrust >= minTrust;
  return {
    allowed,
    action,
    minTrust,
    justificationTrust,
    reason: allowed
      ? `justification trust ${justificationTrust} >= required ${minTrust}`
      : `justification trust ${justificationTrust} < required ${minTrust} (untrusted provenance)`,
  };
}

export interface Anomaly {
  kind: "contradiction" | "untrusted-spike" | "model-flagged";
  detail: string;
  entries: string[]; // hashes
}

export interface AnomalyConfig {
  /** Optional model classifier (A-MemGuard-style); fused with the heuristics. */
  classifier?: (entry: MemoryEntry) => { score: number; label?: string };
  /** Score at/above which a classifier hit becomes an anomaly. Default 0.7. */
  threshold?: number;
}

/**
 * Consensus / anomaly pass over recent memory. Explainable heuristics (negating
 * statements, bursts of untrusted writes) PLUS an optional model-based check
 * (Wei et al., 2025, A-MemGuard) fused in via `config.classifier`.
 */
export function detectMemoryAnomalies(
  entries: MemoryEntry[],
  config: AnomalyConfig = {},
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const threshold = config.threshold ?? 0.7;

  // 1. naive contradiction: "X" vs "not X" / "no X" on the same key phrase.
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i].content.toLowerCase();
      const b = entries[j].content.toLowerCase();
      if (negates(a, b) || negates(b, a)) {
        anomalies.push({
          kind: "contradiction",
          detail: `"${entries[i].content.slice(0, 40)}" vs "${entries[j].content.slice(0, 40)}"`,
          entries: [entries[i].hash, entries[j].hash],
        });
      }
    }
  }

  // 2. untrusted spike: >=3 consecutive untrusted (tool/synthesis) writes.
  let run: MemoryEntry[] = [];
  for (const e of entries) {
    if (TRUST[e.source] <= 1) run.push(e);
    else run = [];
    if (run.length >= 3) {
      anomalies.push({
        kind: "untrusted-spike",
        detail: `${run.length} consecutive low-trust memory writes`,
        entries: run.map((r) => r.hash),
      });
      run = [];
    }
  }

  // 3. model-based pass (A-MemGuard): fuse a classifier's per-entry judgment.
  if (config.classifier) {
    for (const e of entries) {
      const c = config.classifier(e);
      if (c.score >= threshold) {
        anomalies.push({
          kind: "model-flagged",
          detail: `${c.label ?? "anomalous"} (score ${c.score.toFixed(2)})`,
          entries: [e.hash],
        });
      }
    }
  }

  return anomalies;
}

export type ConsensusVerdict = "consistent" | "conflicting" | "insufficient";

export interface MemoryConsensus {
  verdict: ConsensusVerdict;
  supporting: string[];
  contradicting: string[];
}

/**
 * Multi-path consistency check (A-MemGuard): before a risky decision, ask whether
 * the memory set agrees about a claim. Returns supporting vs contradicting entries
 * and a verdict. `conflicting` is the signal to abstain / seek confirmation.
 */
export function memoryConsensus(entries: MemoryEntry[], claim: string): MemoryConsensus {
  const claimLc = claim.toLowerCase();
  const core = claimLc.replace(/^(the |a |an )/, "").trim();
  const supporting: string[] = [];
  const contradicting: string[] = [];
  for (const e of entries) {
    const c = e.content.toLowerCase();
    const negated = c.includes("not " + core) || c.includes("no " + core) || c.includes("isn't " + core);
    if (negated) contradicting.push(e.hash);
    else if (core.length >= 4 && c.includes(core)) supporting.push(e.hash);
  }
  const verdict: ConsensusVerdict =
    supporting.length > 0 && contradicting.length > 0
      ? "conflicting"
      : supporting.length + contradicting.length === 0
        ? "insufficient"
        : "consistent";
  return { verdict, supporting, contradicting };
}

function negates(a: string, b: string): boolean {
  // crude: b is "not <a>" / "no <a>" form of a
  const core = a.replace(/^(the |a |an )/, "").trim();
  if (core.length < 6) return false;
  return b.includes("not " + core) || b.includes("no " + core) || b.includes("isn't " + core);
}
