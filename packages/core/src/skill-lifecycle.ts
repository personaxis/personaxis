/**
 * Skill lifecycle governance (F6; SkillsVote, Liu et al., 2026).
 *
 * We don't author skills; we use them from external sources. Beyond the pre-use
 * security review (skill-review.ts), a skill must be *governed over its life*:
 *   - attribution: record each use + outcome (success/failure) -> success rate;
 *   - recommendation: rank candidates by security verdict, success rate, and
 *     capability match, never recommend an unreviewed/dangerous skill;
 *   - evolution: evidence-gated, a new version is promoted ONLY if it beats the
 *     incumbent on success rate over a minimum sample (revert-on-regression);
 *     persistently failing skills are deprecated.
 *
 * Append-only JSONL ledger (auditable, never rewritten), folded for current state.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SkillOp = "register" | "use" | "outcome" | "promote" | "deprecate";

export interface SkillEvent {
  ts: string;
  skill: string;
  version: string;
  op: SkillOp;
  outcome?: "success" | "failure";
  note?: string;
}

export interface SkillStats {
  skill: string;
  version: string;
  uses: number;
  successes: number;
  failures: number;
  successRate: number;
  status: "active" | "deprecated";
}

export interface SkillCandidate {
  skill: string;
  version: string;
  capabilities: string[];
  /** Verdict from reviewSkill(): ok | review | danger. */
  reviewVerdict: "ok" | "review" | "danger";
}

export interface Recommendation {
  skill: string;
  version: string;
  score: number;
  reasons: string[];
}

export class SkillLedger {
  private file: string;
  constructor(baseDir: string) {
    this.file = join(baseDir, "skills-ledger.jsonl");
  }

  private append(e: SkillEvent): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(e) + "\n", "utf-8");
  }

  events(): SkillEvent[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as SkillEvent);
  }

  register(skill: string, version: string): void {
    this.append({ ts: new Date().toISOString(), skill, version, op: "register" });
  }
  recordUse(skill: string, version: string): void {
    this.append({ ts: new Date().toISOString(), skill, version, op: "use" });
  }
  recordOutcome(skill: string, version: string, success: boolean, note?: string): void {
    this.append({ ts: new Date().toISOString(), skill, version, op: "outcome", outcome: success ? "success" : "failure", note });
  }
  deprecate(skill: string, version: string, note?: string): void {
    this.append({ ts: new Date().toISOString(), skill, version, op: "deprecate", note });
  }
  promote(skill: string, version: string, note?: string): void {
    this.append({ ts: new Date().toISOString(), skill, version, op: "promote", note });
  }

  stats(skill: string, version: string): SkillStats {
    let uses = 0,
      successes = 0,
      failures = 0,
      deprecated = false;
    for (const e of this.events()) {
      if (e.skill !== skill || e.version !== version) continue;
      if (e.op === "use") uses++;
      else if (e.op === "outcome") {
        if (e.outcome === "success") successes++;
        else failures++;
      } else if (e.op === "deprecate") deprecated = true;
      else if (e.op === "promote") deprecated = false;
    }
    const total = successes + failures;
    return {
      skill,
      version,
      uses,
      successes,
      failures,
      successRate: total === 0 ? 0 : Number((successes / total).toFixed(3)),
      status: deprecated ? "deprecated" : "active",
    };
  }

  /**
   * Evidence-gated evolution. Promote `to` over `from` only if `to` has at least
   * `minSample` outcomes AND its success rate beats `from` by `margin`. Otherwise
   * keep the incumbent (revert-on-regression). Returns the decision.
   */
  evolve(
    skill: string,
    from: string,
    to: string,
    opts: { minSample?: number; margin?: number } = {},
  ): { promoted: boolean; reason: string } {
    const minSample = opts.minSample ?? 5;
    const margin = opts.margin ?? 0.02;
    const a = this.stats(skill, from);
    const b = this.stats(skill, to);
    const bTotal = b.successes + b.failures;
    if (bTotal < minSample) {
      return { promoted: false, reason: `candidate has ${bTotal} outcomes (< minSample ${minSample})` };
    }
    if (b.successRate >= a.successRate + margin) {
      this.promote(skill, to, `beats ${from} (${b.successRate} >= ${a.successRate}+${margin})`);
      this.deprecate(skill, from, `superseded by ${to}`);
      return { promoted: true, reason: `${to} promoted over ${from}` };
    }
    return { promoted: false, reason: `${to} (${b.successRate}) does not beat ${from} (${a.successRate}) by ${margin}` };
  }

  /**
   * Recommend skills for a task. Dangerous skills are excluded; the rest are ranked
   * by capability match × trust(review) × (0.5 + successRate).
   */
  recommend(candidates: SkillCandidate[], taskTokens: string[]): Recommendation[] {
    const recs: Recommendation[] = [];
    for (const c of candidates) {
      const reasons: string[] = [];
      if (c.reviewVerdict === "danger") {
        continue; // never recommend a dangerous skill
      }
      const st = this.stats(c.skill, c.version);
      if (st.status === "deprecated") continue;

      const caps = new Set(c.capabilities);
      const matched = taskTokens.filter((t) => caps.has(t));
      const matchScore = taskTokens.length ? matched.length / taskTokens.length : 0;
      const trust = c.reviewVerdict === "ok" ? 1 : 0.6;
      const score = Number((matchScore * trust * (0.5 + st.successRate)).toFixed(3));
      if (matched.length > 0) reasons.push(`matched: ${matched.join(", ")}`);
      reasons.push(`review: ${c.reviewVerdict}`, `successRate: ${st.successRate}`);
      if (score > 0) recs.push({ skill: c.skill, version: c.version, score, reasons });
    }
    return recs.sort((a, b) => b.score - a.score);
  }
}
