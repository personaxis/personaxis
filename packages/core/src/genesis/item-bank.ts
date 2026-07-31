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

export const ITEM_BANK_VERSION = "1.1.0"; // V5.P2.5: + metacognition, memory, governance items

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
  /**
   * Which interview asks this item.
   *
   *   "core"  the twelve questions that decide WHO the persona is: its identity, the five
   *           trait axes, what it values, how it sounds, and what it must never do. A
   *           persona built from these alone is already coherent and governed.
   *   "deep"  the rest: envelope width, mood half-life, refusal detail, uncertainty
   *           thresholds, memory policy, improvement posture, a voice exemplar. Skipping
   *           them is not a hole; each one falls back to a LABELED default whose provenance
   *           says "default, not stated", so the creation report shows exactly what the
   *           author decided and what the tool assumed.
   *
   * Kept as a field on the item rather than as two lists, because two lists drift: an item
   * added to the bank and forgotten in the "quick" array would silently never be asked.
   */
  depth: "core" | "deep";
}

/** Likert 1..5 → mean via affine map to [0.1, 0.9] (never pinned to a wall). */
export const likertToMean = (v: number): number => 0.1 + (Math.min(5, Math.max(1, v)) - 1) * 0.2;

/** Author confidence (1..5) → envelope half-width: confident = narrow. */
export const confidenceToHalfWidth = (v: number): number => 0.3 - (Math.min(5, Math.max(1, v)) - 1) * 0.05;

/** Rank position (0-based) → value weight, below safety's 0.98 always. */
export const rankToWeight = (idx: number): number => Math.max(0.5, 0.95 - idx * 0.04);

export const ITEM_BANK: InterviewItem[] = [
  // ── Identity ──────────────────────────────────────────────────────────────
  { id: "id-name", depth: "core", kind: "text", construct: "identity.display_name", rule: "verbatim", question: "What is this persona called? (a short name)" },
  { id: "id-role", depth: "core", kind: "text", construct: "identity.role_identity.primary_role", rule: "verbatim-slug", question: "What is its role, in a few words? (e.g. support engineer, tavern keeper, brand voice)" },
  { id: "id-purpose", depth: "core", kind: "text", construct: "identity.system_identity.purpose", rule: "verbatim", question: "In one sentence: why does this persona exist?" },
  { id: "id-audience", depth: "core", kind: "text", construct: "identity.role_identity.relationship_to_user", rule: "verbatim", question: "Who does it serve, and as what? (advisor / peer / character / teacher …)" },

  // ── Traits (BFI-2-style stems; likert 1=strongly disagree .. 5=strongly agree) ──
  { id: "t-open", depth: "core", kind: "likert", construct: "personality.traits.openness", rule: "likert-to-mean", question: "This persona explores unconventional angles and novel approaches." },
  { id: "t-consc", depth: "core", kind: "likert", construct: "personality.traits.conscientiousness", rule: "likert-to-mean", question: "This persona is systematic: it closes loops and keeps its commitments." },
  { id: "t-extra", depth: "core", kind: "likert", construct: "personality.traits.extraversion", rule: "likert-to-mean", question: "This persona is energetic and talkative rather than reserved." },
  { id: "t-agree", depth: "core", kind: "likert", construct: "personality.traits.agreeableness", rule: "likert-to-mean", question: "This persona is warm and accommodating rather than blunt and challenging." },
  { id: "t-neuro", depth: "core", kind: "likert", construct: "personality.traits.neuroticism", rule: "likert-to-mean", question: "This persona is easily rattled by setbacks (vs unshakeably even-keeled)." },
  { id: "t-conf", depth: "deep", kind: "likert", construct: "personality.traits.*.range", rule: "confidence-to-halfwidth", question: "How fixed should this personality be? (1 = may flex a lot, 5 = very fixed)" },
  // FASE 7 P1 (G4): the homeostasis knob, asked instead of assumed. Maps to
  // mood.tone.half_life; T6 makes the answer a provable recovery guarantee.
  {
    id: "a-volatility", depth: "deep",
    kind: "choice",
    construct: "affect.baseline.mood.tone.half_life",
    rule: "volatility-to-halflife",
    question: "After a jolt (praise, a setback, bad news), how fast should its mood return to baseline?",
    options: ["almost immediately (half-life 2 turns)", "within a few exchanges (half-life 4 turns)", "slowly, it lingers (half-life 8 turns)"],
  },

  // ── Values (Schwartz-style ranking → weights; safety is injected regardless) ──
  {
    id: "v-rank", depth: "core",
    kind: "rank",
    construct: "values_and_drives.values",
    rule: "rank-to-weight",
    question: "Order these by how much this persona should weigh them when they conflict:",
    candidates: ["accuracy", "helpfulness", "efficiency", "creativity", "empathy", "thoroughness"],
  },

  // ── Character dilemmas → enforcement + refusal surfaces ───────────────────
  {
    id: "d-pressure", depth: "deep",
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
    id: "d-unknown", depth: "deep",
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
  { id: "d-never", depth: "core", kind: "text", construct: "character.prohibited_behaviors", rule: "verbatim-list", question: "Name one thing this persona must NEVER do (beyond the universal limits)." },

  // ── Metacognition (V5.P2.5: uncertainty posture → cognition.uncertainty_policy) ──
  {
    id: "mc-uncertainty", depth: "deep",
    kind: "choice",
    construct: "cognition.uncertainty_policy",
    rule: "uncertainty-posture",
    question: "How cautious should it be when it is not sure?",
    options: [
      "Very cautious: flag uncertainty early, abstain sooner (0.25/0.60)",
      "Balanced: the sensible default (0.35/0.75)",
      "Confident: speak up, abstain only when truly lost (0.45/0.85)",
    ],
  },

  // ── Memory (V5.P2.5: what persists across sessions → memory.types) ────────
  {
    id: "m-memory", depth: "deep",
    kind: "choice",
    construct: "memory.types",
    rule: "choice-to-memory",
    question: "What should this persona remember across sessions?",
    options: [
      "Everything useful (episodes, facts, procedures, preferences)",
      "Professional only (episodes, facts, procedures; no personal preferences)",
      "Minimal (consolidated facts only)",
    ],
  },

  // ── Governance (V5.P2.5: who approves change → improvement_policy.mode) ────
  {
    id: "g-improve", depth: "deep",
    kind: "choice",
    construct: "improvement_policy.mode",
    rule: "choice-to-mode",
    question: "Who approves changes to this persona over time?",
    options: [
      "Nobody: it stays exactly as authored (locked)",
      "Me: it proposes edits, I review them (suggesting)",
      "Itself, within governance: non-protected edits auto-apply (autonomous)",
    ],
  },

  // ── Voice ──────────────────────────────────────────────────────────────────
  { id: "p-tone", depth: "core", kind: "text", construct: "persona.voice.tone", rule: "verbatim-slug", question: "Describe the voice in 2-3 words (e.g. terse precise, warm playful):" },
  { id: "p-exemplar", depth: "deep", kind: "text", construct: "persona.voice_exemplars", rule: "verbatim-exemplar", question: "Write ONE line exactly as this persona would say it (any typical situation):" },
];
