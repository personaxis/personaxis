/**
 * Heuristic appraiser, deterministic, offline Appraiser.
 *
 * Lets the Living Loop run with zero model dependency (tests, demos, air-gapped
 * use, MCP hosts that don't pass a model). It proposes only small bounded nudges;
 * the governance gate + envelope clamp decide what actually applies. The
 * LLM-backed appraiser (constrained decoding) implements
 * the same `Appraiser` interface, so the loop is unchanged.
 */

import type { AppraiseInput, AppraisalSignal, Appraiser } from "./appraisal.js";
import { extractFacts } from "./memory/facts.js";

const POSITIVE =
  /\b(good|great|love|nice|thanks|excellent|win|happy|success|works?|fixed|clean|elegant)\b/gi;
const NEGATIVE =
  /\b(bad|hate|angry|fail|failed|broken|bug|error|slow|ugly|wrong|stuck|frustrat\w*)\b/gi;

/** Signals that an observation is worth an episodic entry (V2-F1.3 dedup: the raw
 * dialog already lives in sessions/; only SALIENT lines earn a ledger slot). */
const SALIENT =
  /\b(recuerda|no olvides|importante|decidimos|acordamos|mi meta|el objetivo|prefiero|remember|don'?t forget|important|we (?:decided|agreed)|my goal|i prefer|deadline|siempre|nunca|always|never)\b/i;

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

    // Stable entity facts (name, alias of the interlocutor) extracted OFFLINE, so
    // an introduction survives sessions even with no model configured (V2-F1.1).
    const facts = input.source === "user" ? extractFacts(input.observation) : [];
    const preferences: AppraisalSignal["preferences"] = facts;

    // The raw dialog already persists in sessions/; the episodic ledger only gets
    // a line when it carries durable signal (a fact, or a salience keyword).
    const memories: AppraisalSignal["memories"] = [];
    if (facts.length) {
      for (const f of facts) {
        memories.push({ content: `${f.key} = ${f.value}`, source: input.source, tags: ["episode", "kind:fact", input.source] });
      }
    } else if (SALIENT.test(input.observation)) {
      memories.push({ content: input.observation.slice(0, 300), source: input.source, tags: ["episode", input.source] });
    }

    const confidence = Math.max(0.2, Math.min(0.9, 0.4 + Math.abs(net) * 0.15 + (facts.length ? 0.3 : 0)));

    return {
      appraisal:
        net === 0
          ? "Neutral observation; holding baseline."
          : `Observation reads ${net > 0 ? "positive" : "negative"} (net ${net}); nudging affect within envelope.`,
      mutations,
      memories,
      preferences,
      confidence,
    };
  }
}
