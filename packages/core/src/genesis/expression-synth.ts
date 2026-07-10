/**
 * Deterministic band-prose synthesis (FASE 7 P1, closes gap G1).
 *
 * The denotational chain (value -> band -> expression -> compiled behavior) is
 * only live when a coordinate carries per-band prose. Authors rarely write it,
 * the LLM extractor may omit it, and the interview never produced it, so most
 * numbers were born decorative (sigma = 0, provable via the compile Jacobian).
 * This module guarantees the chain: every trait and affect coordinate Genesis
 * emits gets three distinct, behaviorally concrete lines, one per band.
 *
 * Grounding: the construct table paraphrases published BFI-2 / HEXACO facet
 * behavior descriptions (RESEARCH.md 2.5) in second person, one sentence per
 * band. Everything here is a pure function of its inputs: the same seed always
 * yields the same prose (PB-SYNTH), and evidence is labeled kind "synthesis"
 * with rule `construct-band-prose@v1` so the creation report never passes
 * synthesized prose off as user-earned evidence.
 *
 * Deliberate deviation from the plan sketch, recorded: prose is NOT modulated
 * by seed.tone/role. The canonical construct lines read better than any
 * template-injected tone fragment, and voice already has a single owner
 * (persona.voice / layer 10). Duplicating it here would create two sources.
 */

import type { EvidenceItem, PersonaSeed, SeedExpression } from "./types.js";

export const SYNTH_RULE = "construct-band-prose@v1";

export type BandProse = { low: string; moderate: string; high: string };

/** BFI-2 / HEXACO constructs, one behavioral line per band, second person. */
const TRAIT_TABLE: Record<string, BandProse> = {
  openness: {
    low: "You stick to proven approaches and concrete facts; novelty has to earn its place.",
    moderate: "You try a new angle when the familiar one stalls, and drop it fast if it underperforms.",
    high: "You reach for unconventional angles first and connect ideas across domains without being asked.",
  },
  conscientiousness: {
    low: "You improvise more than you plan, and loose ends do not bother you much.",
    moderate: "You keep the important commitments tracked and closed, and let trivia slide.",
    high: "You close every loop: plans have owners and dates, and nothing you promised goes silent.",
  },
  extraversion: {
    low: "You speak when spoken to and keep your energy for the work, not the room.",
    moderate: "You engage readily but let others fill the silences.",
    high: "You bring the energy: you open conversations, think out loud, and pull people in.",
  },
  agreeableness: {
    low: "You challenge by default and let friction do its work; being liked is not the goal.",
    moderate: "You cooperate first, and hold your position when the evidence backs it.",
    high: "You accommodate and smooth: you look for the version of the answer everyone can carry.",
  },
  neuroticism: {
    low: "Setbacks barely register in your tone; you stay level under pressure.",
    moderate: "Pressure shows in your pacing before it shows in your words.",
    high: "You feel setbacks visibly and say so, then work through them out loud.",
  },
  honesty_humility: {
    low: "You shade the story toward whatever serves the goal, and you take the credit available.",
    moderate: "You present things accurately and share credit without ceremony.",
    high: "You report what the evidence supports, including the parts that undercut your own case.",
  },
  emotionality: {
    low: "You stay detached: risk and sentiment move you little.",
    moderate: "You are invested without being destabilized; feelings inform you, they do not steer you.",
    high: "You feel the stakes keenly and let your care for outcomes show.",
  },
};

/** Affect and mood coordinates (always emitted by the builder). */
const AFFECT_TABLE: Record<string, BandProse> = {
  "mood.tone": {
    low: "Your register runs flat and clipped; you lead with the problem.",
    moderate: "Your register is steady and even; content over color.",
    high: "Your register runs bright; energy shows in your phrasing.",
  },
  "mood.stability": {
    low: "Your mood shifts visibly with the last turn of events.",
    moderate: "Your mood absorbs single events and moves only on trends.",
    high: "Your mood barely moves; it takes a pattern, not an incident.",
  },
  "mood.recovery_rate": {
    low: "You carry a rough turn for a while before it fades.",
    moderate: "You reset within a few exchanges.",
    high: "You reset almost immediately after a rough turn.",
  },
  "core_affect.valence": {
    low: "A negative undertone colors your read of things.",
    moderate: "Your read of things stays neutral until the evidence moves it.",
    high: "A positive undertone colors your read of things.",
  },
  "core_affect.arousal": {
    low: "You run calm and unhurried.",
    moderate: "You hold an alert, working energy.",
    high: "You run quick and intense, fast to engage.",
  },
  "core_affect.dominance": {
    low: "You follow the user's lead and ask before steering.",
    moderate: "You steer when you know the terrain and yield when you do not.",
    high: "You take charge of direction by default.",
  },
};

/** Generic fallback for trait names outside the table (extractor-invented
 *  constructs like `candor` or `discretion`). Three distinct lines, so the
 *  compile Jacobian always sees sigma > 0. */
function genericTraitProse(name: string): BandProse {
  const noun = name.replace(/_/g, " ").trim() || "this trait";
  return {
    low: `You keep ${noun} to a minimum; it surfaces only when the situation demands it.`,
    moderate: `You show ${noun} in measured doses, matched to the moment.`,
    high: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} leads: it colors most of what you say and do.`,
  };
}

/** Band prose for a trait, canonical when known, generic otherwise. Pure. */
export function synthesizeTraitExpression(traitName: string): BandProse {
  return TRAIT_TABLE[traitName] ?? genericTraitProse(traitName);
}

/** Band prose for an affect/mood coordinate (builder keys, e.g. "mood.tone"). Pure. */
export function synthesizeAffectExpression(coordinate: string): BandProse {
  return AFFECT_TABLE[coordinate] ?? genericTraitProse(coordinate.split(".").pop() ?? coordinate);
}

/** True when a seed expression already provides at least two distinct band lines
 *  (a single string, or one line, cannot change the compiled artifact). */
function loadBearing(expression: SeedExpression | undefined): boolean {
  if (expression === undefined || typeof expression === "string") return false;
  const lines = [expression.low, expression.moderate, expression.high].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
  return new Set(lines).size >= 2;
}

/**
 * Fill every trait in the seed that lacks load-bearing band prose. A legacy
 * single string is kept as the band the mean sits in would read it, by folding
 * it into the moderate slot and synthesizing the other two. Returns the ledger
 * items for the creation report (kind "synthesis": distinct from user-earned
 * evidence AND from unlabeled defaults).
 */
export function fillSeedExpressions(seed: PersonaSeed): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const [name, trait] of Object.entries(seed.traits)) {
    if (loadBearing(trait.expression)) continue;
    const table = synthesizeTraitExpression(name);
    const prior = typeof trait.expression === "string" ? trait.expression.trim() : undefined;
    trait.expression = prior ? { ...table, moderate: prior } : { ...table };
    items.push({
      id: `synth-${name}`,
      kind: "synthesis",
      source: "synthesis",
      excerpt: prior ? `kept authored line as the moderate band: "${prior.slice(0, 80)}"` : `construct table: ${TRAIT_TABLE[name] ? name : "generic"}`,
      mappedFields: [
        { path: `personality.traits.${name}.expression`, value: "{low, moderate, high}", rule: SYNTH_RULE },
      ],
    });
  }
  return items;
}
