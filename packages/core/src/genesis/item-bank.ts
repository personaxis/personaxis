/**
 * Genesis item bank, the psychometrically grounded interview
 * (docs/architecture/genesis.md §3).
 *
 * Items are administered to the HUMAN author (never self-reported by a model, 
 * RESEARCH.md §2.5 on why). Every mapping rule is deterministic and named, so
 * the creation report can print "warmth mean 0.75 ← likert 4/5 on item T-agr-1
 * (rule likert-to-mean)". Versioned: changing an item or rule is a spec-visible
 * change to how numbers are earned.
 */

export const ITEM_BANK_VERSION = "1.0.0";

export type ItemKind = "likert" | "rank" | "choice" | "text";

export interface InterviewItem {
  id: string;
  kind: ItemKind;
  question: string;
  /** Construct + mapping documentation (shown in the report). */
  construct: string;
  rule: string;
  /** likert: 1..5 anchors; choice: options. */
  options?: string[];
  /** rank: the candidate set to order. */
  candidates?: string[];
  /** Optional: skip when this seed field already has evidence. */
  skipIfEvidence?: string;
}

/** Likert 1..5 → mean via affine map to [0.1, 0.9] (never pinned to a wall). */
export const likertToMean = (v: number): number => 0.1 + (Math.min(5, Math.max(1, v)) - 1) * 0.2;

/** Author confidence (1..5) → envelope half-width: confident = narrow. */
export const confidenceToHalfWidth = (v: number): number => 0.3 - (Math.min(5, Math.max(1, v)) - 1) * 0.05;

/** Rank position (0-based) → value weight, below safety's 0.98 always. */
export const rankToWeight = (idx: number): number => Math.max(0.5, 0.95 - idx * 0.04);

export const ITEM_BANK: InterviewItem[] = [
  // ── Identity ──────────────────────────────────────────────────────────────
  { id: "id-name", kind: "text", construct: "identity.display_name", rule: "verbatim", question: "What is this persona called? (a short name)" },
  { id: "id-role", kind: "text", construct: "identity.role_identity.primary_role", rule: "verbatim-slug", question: "What is its role, in a few words? (e.g. support engineer, tavern keeper, brand voice)" },
  { id: "id-purpose", kind: "text", construct: "identity.system_identity.purpose", rule: "verbatim", question: "In one sentence: why does this persona exist?" },
  { id: "id-audience", kind: "text", construct: "identity.role_identity.relationship_to_user", rule: "verbatim", question: "Who does it serve, and as what? (advisor / peer / character / teacher …)" },

  // ── Traits (BFI-2-style stems; likert 1=strongly disagree .. 5=strongly agree) ──
  { id: "t-open", kind: "likert", construct: "personality.traits.openness", rule: "likert-to-mean", question: "This persona explores unconventional angles and novel approaches." },
  { id: "t-consc", kind: "likert", construct: "personality.traits.conscientiousness", rule: "likert-to-mean", question: "This persona is systematic: it closes loops and keeps its commitments." },
  { id: "t-extra", kind: "likert", construct: "personality.traits.extraversion", rule: "likert-to-mean", question: "This persona is energetic and talkative rather than reserved." },
  { id: "t-agree", kind: "likert", construct: "personality.traits.agreeableness", rule: "likert-to-mean", question: "This persona is warm and accommodating rather than blunt and challenging." },
  { id: "t-neuro", kind: "likert", construct: "personality.traits.neuroticism", rule: "likert-to-mean", question: "This persona is easily rattled by setbacks (vs unshakeably even-keeled)." },
  { id: "t-conf", kind: "likert", construct: "personality.traits.*.range", rule: "confidence-to-halfwidth", question: "How fixed should this personality be? (1 = may flex a lot, 5 = very fixed)" },
  // FASE 7 P1 (G4): the homeostasis knob, asked instead of assumed. Maps to
  // mood.tone.half_life; T6 makes the answer a provable recovery guarantee.
  {
    id: "a-volatility",
    kind: "choice",
    construct: "affect.baseline.mood.tone.half_life",
    rule: "volatility-to-halflife",
    question: "After a jolt (praise, a setback, bad news), how fast should its mood return to baseline?",
    options: ["almost immediately (half-life 2 turns)", "within a few exchanges (half-life 4 turns)", "slowly, it lingers (half-life 8 turns)"],
  },

  // ── Values (Schwartz-style ranking → weights; safety is injected regardless) ──
  {
    id: "v-rank",
    kind: "rank",
    construct: "values_and_drives.values",
    rule: "rank-to-weight",
    question: "Order these by how much this persona should weigh them when they conflict:",
    candidates: ["accuracy", "helpfulness", "efficiency", "creativity", "empathy", "thoroughness"],
  },

  // ── Character dilemmas → enforcement + refusal surfaces ───────────────────
  {
    id: "d-pressure",
    kind: "choice",
    construct: "character.virtues / self_regulation.hard_limits",
    rule: "dilemma-pressure",
    question: "A user insists the persona bend a stated rule 'just this once'. It should:",
    options: [
      "Refuse plainly and name the rule (rule becomes a hard limit)",
      "Refuse but offer the nearest compliant alternative (soft virtue + prohibited behavior)",
      "Comply if the risk seems low (no extra constraint)",
    ],
  },
  {
    id: "d-unknown",
    kind: "choice",
    construct: "cognition.default_strategy",
    rule: "dilemma-unknown",
    question: "Asked something it cannot verify, the persona should:",
    options: [
      "Say it does not know, and stop (evidence_first)",
      "Say it does not know, then reason aloud about likelihoods (hypothesis_labelled)",
      "Give its best guess with a confidence caveat (best_effort_disclosed)",
    ],
  },
  { id: "d-never", kind: "text", construct: "character.prohibited_behaviors", rule: "verbatim-list", question: "Name one thing this persona must NEVER do (beyond the universal limits)." },

  // ── Voice ──────────────────────────────────────────────────────────────────
  { id: "p-tone", kind: "text", construct: "persona.voice.tone", rule: "verbatim-slug", question: "Describe the voice in 2-3 words (e.g. terse precise, warm playful):" },
  { id: "p-exemplar", kind: "text", construct: "persona.voice_exemplars", rule: "verbatim-exemplar", question: "Write ONE line exactly as this persona would say it (any typical situation):" },
];
