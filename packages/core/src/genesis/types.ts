/**
 * Genesis, creating an AI Persona from zero (docs/architecture/genesis.md).
 *
 * Every entry mode (prompt, interview, project, import, transcript) produces the
 * same two artifacts: a PersonaSeed (the structured intermediate the spec builder
 * renders into a valid 10-layer document) and an EvidenceLedger (WHY every
 * quantitative field has the value it has, C6, "every number earned").
 */

export type EvidenceKind =
  | "answer"
  | "document"
  | "dialogue"
  | "imported-field"
  | "inference"
  | "default"
  /** FASE 7 P1: deterministic construct-table prose (expression-synth.ts). A third
   *  honesty tier: not user-earned evidence, but not an unlabeled default either. */
  | "synthesis";

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  /** Where the content came from (mirrors the runtime provenance sources). */
  source: "user" | "tool" | "internal" | "synthesis";
  /** Short human-readable excerpt of the evidence (an answer, a doc line, a card field). */
  excerpt: string;
  /** Spec dot-paths this evidence justified, with the mapping rule applied. */
  mappedFields: Array<{ path: string; value: unknown; rule: string }>;
}

export interface EvidenceLedger {
  items: EvidenceItem[];
}

/** Per-band expression prose (the denotational fields, F6.2). */
export type SeedExpression = string | Partial<Record<"low" | "moderate" | "high", string>>;

export interface SeedTrait {
  mean: number;
  range: [number, number];
  expression?: SeedExpression;
  bands?: { low_max?: number; moderate_max?: number };
  halfLife?: number;
}

export interface PersonaSeed {
  slug: string;
  displayName: string;
  description: string;
  role: string;
  purpose: string;
  relationshipToUser?: string;
  origin?: string;
  selfConcept?: string;

  /** persona.voice */
  tone?: string;
  formality?: number;
  warmth?: number;
  verbosity?: string;

  /** personality.traits, model chosen by key count/names (big_five | hexaco | hybrid_traits). */
  traits: Record<string, SeedTrait>;
  /** values_and_drives.values, safety is injected by the builder regardless. */
  values: Record<string, { weight: number; type?: string }>;
  /** character.virtues, honesty (hard) is injected by the builder regardless. */
  virtues: Record<string, { description: string; priority: number; enforcement: "hard" | "soft" }>;

  /** self_regulation.hard_limits, the three universals are injected regardless. */
  hardLimits: string[];
  prohibitedBehaviors: string[];
  goals: string[];
  antiGoals: string[];

  allowedDomains?: string[];
  prohibitedDomains?: string[];
  reasoningModes?: string[];
  defaultStrategy?: string;

  /** persona (layer 10) prompting material. */
  youAre?: string;
  voiceExemplars?: Array<{ context?: string; user?: string; persona: string }>;
  behavioralAnchors?: { do?: string[]; dont?: string[]; examples?: string[] };

  improvementMode?: "locked" | "suggesting" | "autonomous";
  /** FASE 7 P1 (G4): mood.tone half_life in turns; the interview's volatility
   *  item maps here (rule volatility-to-halflife). Builder default: 4. */
  moodHalfLife?: number;
  memoryTypes?: Partial<Record<"episodic" | "semantic" | "procedural" | "autobiographical" | "user_preferences" | "evaluations", boolean>>;
}

/** A provider-agnostic structured-output caller (the CLI injects its provider). */
export type StructuredCaller = (prompt: string, schema: unknown, name: string) => Promise<unknown>;

export interface GenesisResult {
  /** The full frontmatter object (valid v1.1.0 by construction). */
  spec: Record<string, unknown>;
  /** The complete personaxis.md document (frontmatter + body). */
  document: string;
  seed: PersonaSeed;
  ledger: EvidenceLedger;
}
