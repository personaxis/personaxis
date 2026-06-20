/**
 * Heuristic appraiser — deterministic, offline Appraiser.
 *
 * Lets the Living Loop run with zero model dependency (tests, demos, air-gapped
 * use, MCP hosts that don't pass a model). It proposes only small bounded nudges;
 * the governance gate + envelope clamp decide what actually applies. The
 * LLM-backed appraiser (constrained decoding, plan/04-small-models) implements
 * the same `Appraiser` interface, so the loop is unchanged.
 */

import type { AppraiseInput, AppraisalSignal, Appraiser } from "./appraisal.js";

const POSITIVE =
  /\b(good|great|love|nice|thanks|excellent|win|happy|success|works?|fixed|clean|elegant)\b/gi;
const NEGATIVE =
  /\b(bad|hate|angry|fail|failed|broken|bug|error|slow|ugly|wrong|stuck|frustrat\w*)\b/gi;

function count(re: RegExp, s: string): number {
  return (s.match(re) ?? []).length;
}

export class HeuristicAppraiser implements Appraiser {
  async appraise(input: AppraiseInput): Promise<AppraisalSignal> {
    const pos = count(POSITIVE, input.observation);
    const neg = count(NEGATIVE, input.observation);
    const net = pos - neg;
    const magnitude = Math.min(0.12, Math.abs(net) * 0.04);
    const dir = Math.sign(net);

    const mutations: AppraisalSignal["mutations"] = [];
    if (dir !== 0) {
      if (input.mutableFields.includes("mood.tone")) {
        mutations.push({ field: "mood.tone", delta: dir * magnitude, reason: "tone of observation" });
      }
      if (input.mutableFields.includes("affect.valence")) {
        mutations.push({
          field: "affect.valence",
          delta: dir * magnitude,
          reason: "affective valence of observation",
        });
      }
    }

    const memories: AppraisalSignal["memories"] = [
      { content: input.observation.slice(0, 480), source: input.source, tags: ["episode", input.source] },
    ];

    const confidence = Math.max(0.2, Math.min(0.9, 0.4 + Math.abs(net) * 0.15));

    return {
      appraisal:
        net === 0
          ? "Neutral observation; holding baseline."
          : `Observation reads ${net > 0 ? "positive" : "negative"} (net ${net}); nudging affect within envelope.`,
      mutations,
      memories,
      confidence,
    };
  }
}
