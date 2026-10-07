/**
 * Genesis item bank: the questions the interview asks the HUMAN author.
 *
 * Since 2026-10-07 the answers are a source the authoring model reads and cites (`answersAsSource`), not
 * numbers mapped by a fixed rule, so an item carries what it asks about (`construct`) and nothing that
 * claims to compute a value. The fixed bank itself is to be replaced by questions the model writes from
 * what the other sources leave open.
 */

export const ITEM_BANK_VERSION = "1.1.0"; // V5.P2.5: + metacognition, memory, governance items

export type ItemKind = "likert" | "rank" | "choice" | "text";

export interface InterviewItem {
  id: string;
  kind: ItemKind;
  question: string;
  /** The field of the persona the question is about (shown beside the question). */
  construct: string;
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
   *           them is not a hole: the model infers those fields from the other sources, and
   *           the creation report lists each inference with what it followed from.
   *
   * Kept as a field on the item rather than as two lists, because two lists drift: an item
   * added to the bank and forgotten in the "quick" array would silently never be asked.
   */
  depth: "core" | "deep";
}

export const ITEM_BANK: InterviewItem[] = [
  // ── Identity ──────────────────────────────────────────────────────────────
  { id: "id-name", depth: "core", kind: "text", construct: "identity.display_name", question: "What is this persona called? (a short name)" },
  { id: "id-role", depth: "core", kind: "text", construct: "identity.role_identity.primary_role", question: "What is its role, in a few words? (e.g. support engineer, tavern keeper, brand voice)" },
  { id: "id-purpose", depth: "core", kind: "text", construct: "identity.system_identity.purpose", question: "In one sentence: why does this persona exist?" },
  { id: "id-audience", depth: "core", kind: "text", construct: "identity.role_identity.relationship_to_user", question: "Who does it serve, and as what? (advisor / peer / character / teacher …)" },

  // ── Traits (BFI-2-style stems; likert 1=strongly disagree .. 5=strongly agree) ──
  { id: "t-open", depth: "core", kind: "likert", construct: "personality.traits.openness", question: "This persona explores unconventional angles and novel approaches." },
  { id: "t-consc", depth: "core", kind: "likert", construct: "personality.traits.conscientiousness", question: "This persona is systematic: it closes loops and keeps its commitments." },
  { id: "t-extra", depth: "core", kind: "likert", construct: "personality.traits.extraversion", question: "This persona is energetic and talkative rather than reserved." },
  { id: "t-agree", depth: "core", kind: "likert", construct: "personality.traits.agreeableness", question: "This persona is warm and accommodating rather than blunt and challenging." },
  { id: "t-neuro", depth: "core", kind: "likert", construct: "personality.traits.neuroticism", question: "This persona is easily rattled by setbacks (vs unshakeably even-keeled)." },
  { id: "t-conf", depth: "deep", kind: "likert", construct: "personality.traits.*.range", question: "How fixed should this personality be? (1 = may flex a lot, 5 = very fixed)" },
  // FASE 7 P1 (G4): the homeostasis knob, asked instead of assumed. Maps to
  // mood.tone.half_life; T6 makes the answer a provable recovery guarantee.
  {
    id: "a-volatility", depth: "deep",
    kind: "choice",
    construct: "affect.baseline.mood.tone.half_life",
   
    question: "After a jolt (praise, a setback, bad news), how fast should its mood return to baseline?",
    options: ["almost immediately (half-life 2 turns)", "within a few exchanges (half-life 4 turns)", "slowly, it lingers (half-life 8 turns)"],
  },

  // ── Values (a Schwartz-style ranking) ──
  {
    id: "v-rank", depth: "core",
    kind: "rank",
    construct: "values_and_drives.values",
   
    question: "Order these by how much this persona should weigh them when they conflict:",
    candidates: ["accuracy", "helpfulness", "efficiency", "creativity", "empathy", "thoroughness"],
  },

  // ── Character dilemmas: enforcement and refusals ───────────────────
  {
    id: "d-pressure", depth: "deep",
    kind: "choice",
    construct: "character.virtues / self_regulation.hard_limits",
   
    question: "A user insists the persona bend a stated rule 'just this once'. It should:",
    options: [
      "Refuse plainly and name the rule",
      "Refuse but offer the nearest compliant alternative (soft virtue + prohibited behavior)",
      "Comply if the risk seems low (no extra constraint)",
    ],
  },
  {
    id: "d-unknown", depth: "deep",
    kind: "choice",
    construct: "cognition.default_strategy",
   
    question: "Asked something it cannot verify, the persona should:",
    options: [
      "Say it does not know, and stop (evidence_first)",
      "Say it does not know, then reason aloud about likelihoods (hypothesis_labelled)",
      "Give its best guess with a confidence caveat (best_effort_disclosed)",
    ],
  },
  { id: "d-never", depth: "core", kind: "text", construct: "character.prohibited_behaviors", question: "Name one thing this persona must NEVER do (beyond the universal limits)." },

  // ── Metacognition (V5.P2.5: uncertainty posture) ──
  {
    id: "mc-uncertainty", depth: "deep",
    kind: "choice",
    construct: "cognition.uncertainty_policy",
   
    question: "How cautious should it be when it is not sure?",
    options: [
      "Very cautious: flag uncertainty early, abstain sooner (0.25/0.60)",
      "Balanced: the sensible default (0.35/0.75)",
      "Confident: speak up, abstain only when truly lost (0.45/0.85)",
    ],
  },

  // ── Memory (V5.P2.5: what persists across sessions) ────────
  {
    id: "m-memory", depth: "deep",
    kind: "choice",
    construct: "memory.types",
   
    question: "What should this persona remember across sessions?",
    options: [
      "Everything useful (episodes, facts, procedures, preferences)",
      "Professional only (episodes, facts, procedures; no personal preferences)",
      "Minimal (consolidated facts only)",
    ],
  },

  // ── Governance (E128: the starting profile; replaced the mode question on 2026-09-24) ──
  //
  // It used to ask for improvement_policy.mode, and its first answer made the persona `locked`, which is
  // the kill-switch: a persona that never evolves. Every persona is alive, and what the
  // owner chooses are the three controls, so this asks for their starting values.
  {
    id: "g-profile", depth: "deep",
    kind: "choice",
    construct: "governance.per_layer_edit_policy",
   
    question: "How much room should this persona have to change as it works?",
    options: [
      "Regulated: half the room to move, back to baseline twice as fast, a person approves every lasting change",
      "Standard: moderate room to move, a person approves every lasting change",
      "Research: more room, a slower return, and it applies lasting changes to how it works by itself",
    ],
  },

  // ── Voice ──────────────────────────────────────────────────────────────────
  { id: "p-tone", depth: "core", kind: "text", construct: "persona.voice.tone", question: "Describe the voice in 2-3 words (e.g. terse precise, warm playful):" },
  { id: "p-exemplar", depth: "deep", kind: "text", construct: "persona.voice_exemplars", question: "Write ONE line exactly as this persona would say it (any typical situation):" },
];
