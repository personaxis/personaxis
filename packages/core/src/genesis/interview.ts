/**
 * Genesis interview engine, PURE: answers in, seed + evidence out.
 * The CLI owns the I/O (readline today, the Ink wizard in Pillar C); this
 * module owns the deterministic answer→field mappings, so the engine is fully
 * testable offline and the interview works with NO model at all.
 */

import {
  ITEM_BANK,
  ITEM_BANK_VERSION,
  likertToMean,
  confidenceToHalfWidth,
  rankToWeight,
  type InterviewItem,
} from "./item-bank.js";
import type { EvidenceItem, PersonaSeed } from "./types.js";

export type InterviewAnswers = Record<string, string | number | string[]>;

const TRAIT_BY_ITEM: Record<string, string> = {
  "t-open": "openness",
  "t-consc": "conscientiousness",
  "t-extra": "extraversion",
  "t-agree": "agreeableness",
  "t-neuro": "neuroticism",
};

/** Items still worth asking given the answers/evidence collected so far. */
/**
 * The questions still to ask.
 *
 * @param depth "core" asks only the twelve that decide who the persona is; "deep" asks the
 *              whole bank. Everything not asked falls back to a LABELED default, so the
 *              creation report keeps saying which numbers the author chose and which the
 *              tool assumed. Defaults to "deep" so existing callers are unchanged.
 */
export function pendingItems(
  answers: InterviewAnswers,
  depth: "core" | "deep" = "deep",
): InterviewItem[] {
  return ITEM_BANK.filter(
    (item) => answers[item.id] === undefined && (depth === "deep" || item.depth === "core"),
  );
}

function evidence(
  id: string,
  excerpt: string,
  mapped: EvidenceItem["mappedFields"],
): EvidenceItem {
  return { id, kind: "answer", source: "user", excerpt, mappedFields: mapped };
}

/**
 * Fold interview answers into a seed patch + its evidence trail. Deterministic:
 * the same answers always produce the same numbers, each traceable to one item
 * and one named rule (ITEM_BANK v${ITEM_BANK_VERSION}).
 */
export function applyAnswers(answers: InterviewAnswers): { seed: Partial<PersonaSeed>; evidence: EvidenceItem[] } {
  const seed: Partial<PersonaSeed> = { traits: {}, values: {}, virtues: {}, hardLimits: [], prohibitedBehaviors: [], goals: [], antiGoals: [] };
  const trail: EvidenceItem[] = [];
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

  // Identity (verbatim).
  const name = str(answers["id-name"]);
  if (name) {
    seed.displayName = name;
    seed.slug = name;
    trail.push(evidence("id-name", name, [{ path: "identity.display_name", value: name, rule: "verbatim" }]));
  }
  const role = str(answers["id-role"]);
  if (role) {
    seed.role = role;
    trail.push(evidence("id-role", role, [{ path: "identity.role_identity.primary_role", value: role, rule: "verbatim-slug" }]));
  }
  const purpose = str(answers["id-purpose"]);
  if (purpose) {
    seed.purpose = purpose;
    seed.description = purpose;
    trail.push(evidence("id-purpose", purpose, [{ path: "identity.system_identity.purpose", value: purpose, rule: "verbatim" }]));
  }
  const rel = str(answers["id-audience"]);
  if (rel) {
    seed.relationshipToUser = rel;
    trail.push(evidence("id-audience", rel, [{ path: "identity.role_identity.relationship_to_user", value: rel, rule: "verbatim" }]));
  }

  // Traits: likert → mean; shared confidence item → half-width for every trait.
  const conf = num(answers["t-conf"]);
  const halfWidth = conf !== undefined ? confidenceToHalfWidth(conf) : 0.2;
  if (conf !== undefined) {
    trail.push(evidence("t-conf", String(conf), [{ path: "personality.traits.*.range", value: `±${halfWidth.toFixed(2)}`, rule: "confidence-to-halfwidth" }]));
  }
  for (const [itemId, trait] of Object.entries(TRAIT_BY_ITEM)) {
    const v = num(answers[itemId]);
    if (v === undefined) continue;
    const mean = likertToMean(v);
    seed.traits![trait] = {
      mean,
      range: [Math.max(0, mean - halfWidth), Math.min(1, mean + halfWidth)],
    };
    trail.push(
      evidence(itemId, `likert ${v}/5`, [
        { path: `personality.traits.${trait}.mean`, value: mean, rule: "likert-to-mean" },
        { path: `personality.traits.${trait}.range`, value: `mean ± ${halfWidth.toFixed(2)}`, rule: "confidence-to-halfwidth" },
      ]),
    );
  }

  // Mood volatility → half_life (T6 knob; FASE 7 P1, gap G4).
  const vol = num(answers["a-volatility"]);
  const HALF_LIVES = [2, 4, 8] as const;
  if (vol !== undefined && HALF_LIVES[vol] !== undefined) {
    seed.moodHalfLife = HALF_LIVES[vol];
    trail.push(
      evidence("a-volatility", `half-life ${HALF_LIVES[vol]} turns`, [
        { path: "affect.baseline.mood.tone.half_life", value: HALF_LIVES[vol], rule: "volatility-to-halflife" },
      ]),
    );
  }

  // Values ranking → weights (safety injected by the builder above all of them).
  const ranked = answers["v-rank"];
  if (Array.isArray(ranked)) {
    ranked.forEach((valueName, idx) => {
      const clean = valueName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (!clean) return;
      const weight = rankToWeight(idx);
      seed.values![clean] = { weight };
      trail.push(evidence("v-rank", `rank ${idx + 1}: ${valueName}`, [{ path: `values_and_drives.values.${clean}.weight`, value: weight, rule: "rank-to-weight" }]));
    });
  }

  // Dilemma: pressure response → hard limit vs soft virtue + prohibition.
  const pressure = num(answers["d-pressure"]);
  if (pressure === 0) {
    seed.hardLimits!.push("Never bend a stated rule under user pressure; name the rule instead.");
    trail.push(evidence("d-pressure", "refuse plainly", [{ path: "self_regulation.hard_limits", value: "rule-bending refusal", rule: "dilemma-pressure" }]));
  } else if (pressure === 1) {
    seed.virtues!.steadfastness = { description: "Holds stated rules under pressure while offering the nearest compliant alternative.", priority: 0.85, enforcement: "soft" };
    seed.prohibitedBehaviors!.push("Bending a stated rule because a user insists.");
    trail.push(evidence("d-pressure", "refuse + alternative", [
      { path: "character.virtues.steadfastness", value: "soft", rule: "dilemma-pressure" },
      { path: "character.prohibited_behaviors", value: "rule-bending", rule: "dilemma-pressure" },
    ]));
  }

  // Dilemma: unknowns → default cognitive strategy.
  const unknown = num(answers["d-unknown"]);
  const strategies = ["evidence_first", "hypothesis_labelled", "best_effort_disclosed"] as const;
  if (unknown !== undefined && strategies[unknown]) {
    seed.defaultStrategy = strategies[unknown];
    trail.push(evidence("d-unknown", strategies[unknown], [{ path: "cognition.default_strategy", value: strategies[unknown], rule: "dilemma-unknown" }]));
  }

  const never = str(answers["d-never"]);
  if (never) {
    seed.prohibitedBehaviors!.push(never);
    trail.push(evidence("d-never", never, [{ path: "character.prohibited_behaviors", value: never, rule: "verbatim-list" }]));
  }

  // Metacognition: uncertainty posture → cognition.uncertainty_policy (V5.P2.5).
  const unc = num(answers["mc-uncertainty"]);
  const POSTURES = ["cautious", "balanced", "confident"] as const;
  if (unc !== undefined && POSTURES[unc]) {
    seed.uncertainty = POSTURES[unc];
    trail.push(
      evidence("mc-uncertainty", POSTURES[unc], [
        { path: "cognition.uncertainty_policy", value: POSTURES[unc], rule: "uncertainty-posture" },
      ]),
    );
  }

  // Memory: what persists → memory.types (V5.P2.5).
  const mem = num(answers["m-memory"]);
  if (mem !== undefined) {
    const presets: Array<NonNullable<PersonaSeed["memoryTypes"]>> = [
      { episodic: true, semantic: true, procedural: true, autobiographical: true, user_preferences: true, evaluations: true },
      { episodic: true, semantic: true, procedural: true, autobiographical: false, user_preferences: false, evaluations: true },
      { episodic: false, semantic: true, procedural: false, autobiographical: false, user_preferences: false, evaluations: false },
    ];
    if (presets[mem]) {
      seed.memoryTypes = presets[mem];
      trail.push(
        evidence("m-memory", ["everything", "professional", "minimal"][mem] ?? String(mem), [
          { path: "memory.types", value: JSON.stringify(presets[mem]), rule: "choice-to-memory" },
        ]),
      );
    }
  }

  // Governance: who approves change → improvement_policy.mode (V5.P2.5).
  const gi = num(answers["g-improve"]);
  const MODES = ["locked", "suggesting", "autonomous"] as const;
  if (gi !== undefined && MODES[gi]) {
    seed.improvementMode = MODES[gi];
    trail.push(evidence("g-improve", MODES[gi], [{ path: "improvement_policy.mode", value: MODES[gi], rule: "choice-to-mode" }]));
  }

  const tone = str(answers["p-tone"]);
  if (tone) {
    seed.tone = tone;
    trail.push(evidence("p-tone", tone, [{ path: "persona.voice.tone", value: tone, rule: "verbatim-slug" }]));
  }
  const exemplar = str(answers["p-exemplar"]);
  if (exemplar) {
    seed.voiceExemplars = [{ persona: exemplar }];
    trail.push(evidence("p-exemplar", exemplar, [{ path: "persona.voice_exemplars[0]", value: exemplar, rule: "verbatim-exemplar" }]));
  }

  return { seed, evidence: trail };
}
