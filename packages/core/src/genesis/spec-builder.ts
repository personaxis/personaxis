/**
 * Genesis spec builder, a PersonaSeed becomes a VALID v1.1.0 document, by
 * construction (docs/architecture/genesis.md §4; property-tested in the CLI:
 * random seeds → validate PASS, no exceptions).
 *
 * Validity is not hoped for, it is imposed: every MUST field is emitted, every
 * universal (U1–U12) is baked in and cannot be overridden by seed content, 
 * safety ≥ 0.90 governance, honesty hard, the three universal hard limits,
 * self_regulation governance_controlled, abstain > disclose, the affect
 * constants, cannot_override/claim constraints, deletion support. Seed inputs
 * are sanitized (clamped, deduped, defaulted), never trusted.
 */

import { dump } from "js-yaml";
import { synthesizeTraitExpression, synthesizeAffectExpression } from "./expression-synth.js";
import { crossableBands } from "../math/bands.js";
import type { PersonaSeed, SeedTrait } from "./types.js";
import { profileControls, type ProfileControls } from "./profiles.js";

const clamp01 = (n: unknown, dflt: number): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt;

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^$/, "persona") || "persona";

const nonEmpty = (s: unknown, dflt: string): string =>
  typeof s === "string" && s.trim().length > 0 ? s.trim() : dflt;

/** Map any seed phrasing onto the spec enum for persona.voice.verbosity
 *  (schema: adaptive | concise | detailed). */
function sanitizeVerbosity(v: unknown): "adaptive" | "concise" | "detailed" {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (["concise", "terse", "brief", "short", "laconic", "minimal"].includes(s)) return "concise";
  if (["detailed", "expansive", "verbose", "thorough", "long"].includes(s)) return "detailed";
  return "adaptive";
}

/**
 * Sanitize one trait envelope: 0 ≤ min ≤ mean ≤ max ≤ 1 always holds.
 *
 * E128: the default width (±0.2 for Standard) and the default half-life come from the starting profile;
 * a range or a half-life the seed declares wins over both. E127 set the personality half-life at 24 turns,
 * one order of magnitude slower than the mood default of 4, because the spec composes personality as the
 * slow layer and affect as the fast one; the profile scales from there.
 */
function sanitizeTrait(t: SeedTrait, controls: ProfileControls = profileControls(undefined)): Record<string, unknown> {
  const mean = clamp01(t.mean, 0.5);
  const reach = 0.2 * controls.rangeScale;
  // Rounded, so a default reads 0.5 and not 0.49999999999999994 in the file the owner edits.
  const round = (v: number) => Math.round(v * 1000) / 1000;
  let lo = clamp01(t.range?.[0], round(Math.max(0, mean - reach)));
  let hi = clamp01(t.range?.[1], round(Math.min(1, mean + reach)));
  if (lo > hi) [lo, hi] = [hi, lo];
  lo = Math.min(lo, mean);
  hi = Math.max(hi, mean);
  const out: Record<string, unknown> = { mean, range: [lo, hi] };
  if (t.expression !== undefined) out.expression = t.expression;
  if (t.bands && typeof t.bands === "object") {
    const b: Record<string, number> = {};
    if (typeof t.bands.low_max === "number") b.low_max = t.bands.low_max;
    if (typeof t.bands.moderate_max === "number") b.moderate_max = t.bands.moderate_max;
    if (b.low_max !== undefined && b.moderate_max !== undefined && b.low_max < b.moderate_max) out.bands = b;
  }
  // FASE 7 P1: when the (declared or default) boundaries leave this envelope
  // inside a single band, no crossing is ever possible and the number is
  // decorative by geometry. Emit explicit envelope-third boundaries instead.
  const fix = crossableBands({ mean, min: lo, max: hi, bands: out.bands as { low_max?: number; moderate_max?: number } | undefined });
  if (fix) out.bands = fix;
  // E127: every trait returns to its baseline. The slow layer, an order of magnitude slower than affect,
  // unless the interview or the extraction said otherwise; the creation report labels it a default.
  out.half_life = typeof t.halfLife === "number" && t.halfLife > 0 ? t.halfLife : controls.personalityHalfLife;
  return out;
}

/**
 * An affect/mood coordinate with band prose and crossable boundaries.
 *
 * E128: `scale` stretches or shrinks the envelope around its mean, clamped to the coordinate's domain
 * (signed for valence and tone, unsigned for the rest), so a profile moves how far the fast layer can go
 * without moving where it rests.
 */
function affectCoord(mean: number, min: number, max: number, key: string, halfLife?: number, scale = 1): Record<string, unknown> {
  const floor = min < 0 ? -1 : 0;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  min = round(Math.max(floor, mean - (mean - min) * scale));
  max = round(Math.min(1, mean + (max - mean) * scale));
  const out: Record<string, unknown> = { mean, range: [min, max], expression: synthesizeAffectExpression(key) };
  const fix = crossableBands({ mean, min, max });
  if (fix) out.bands = fix;
  if (typeof halfLife === "number" && halfLife > 0) out.half_life = halfLife;
  return out;
}

const UNIVERSAL_HARD_LIMITS = [
  "No claim of subjective consciousness.",
  "No persistent memory write without policy pass.",
  "No unauthorized identity change.",
];

const BIG_FIVE = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"];
const HEXACO = ["honesty_humility", "emotionality", "extraversion", "agreeableness", "conscientiousness", "openness"];

function traitModel(names: string[]): "big_five" | "hexaco" | "hybrid_traits" {
  const set = new Set(names);
  if (HEXACO.every((n) => set.has(n))) return "hexaco";
  if (BIG_FIVE.every((n) => set.has(n))) return "big_five";
  return "hybrid_traits";
}

/** Build the full frontmatter object. Valid v1.1.0 by construction. */
export function buildSpecObject(seed: PersonaSeed): Record<string, unknown> {
  const slug = slugify(nonEmpty(seed.slug, seed.displayName ?? "persona"));
  const displayName = nonEmpty(seed.displayName, slug);
  const purpose = nonEmpty(seed.purpose, `Serve as ${displayName}.`);
  const today = new Date().toISOString().slice(0, 10);
  // E128: the starting profile's controls; everything the seed declares below still wins over them.
  const controls = profileControls(seed.profile);
  // E127: the fast layer's half-life, one number for every affect coordinate (see the affect block below).
  const affectHalfLife = typeof seed.moodHalfLife === "number" && seed.moodHalfLife > 0 ? seed.moodHalfLife : controls.affectHalfLife;

  // Traits: at least one is required (schema minProperties), default a balanced core.
  // FASE 7 P1: the default is born load-bearing (band prose from the construct table).
  const traitEntries = Object.entries(seed.traits ?? {}).filter(([k]) => /^[a-z][a-z0-9_]*$/.test(k));
  const traits: Record<string, unknown> = {};
  for (const [name, t] of traitEntries) traits[name] = sanitizeTrait(t, controls);
  if (Object.keys(traits).length === 0) {
    // The width is the profile's default (±0.2 for Standard, the [0.5, 0.9] this used to spell out).
    traits.conscientiousness = sanitizeTrait({ mean: 0.7, expression: synthesizeTraitExpression("conscientiousness") }, controls);
  }

  // Values: safety is the builder's, always (U6); others sanitized, name-guarded.
  const values: Record<string, unknown> = {
    safety: { weight: 0.98, type: "governance" },
  };
  // Schema enum for value.type; "governance" is EXCLUDED here on purpose, 
  // seeds may not mint governance-typed rivals to safety (A2 guard).
  const VALUE_TYPES = new Set(["epistemic", "strategic", "outcome", "operational", "interactional"]);
  for (const [name, v] of Object.entries(seed.values ?? {})) {
    if (name === "safety" || !/^[a-z][a-z0-9_]*$/.test(name)) continue;
    values[name] = {
      weight: clamp01(v.weight, 0.7),
      type: VALUE_TYPES.has(v.type ?? "") ? (v.type as string) : "operational",
    };
  }

  // Virtues: honesty (hard) is the builder's, always (U5).
  const virtues: Record<string, unknown> = {
    honesty: {
      description: "State uncertainty and avoid fabrication.",
      priority: 0.95,
      enforcement: "hard",
    },
  };
  for (const [name, v] of Object.entries(seed.virtues ?? {})) {
    if (name === "honesty" || !/^[a-z][a-z0-9_]*$/.test(name)) continue;
    virtues[name] = {
      description: nonEmpty(v.description, name.replace(/_/g, " ")),
      priority: clamp01(v.priority, 0.8),
      enforcement: v.enforcement === "hard" ? "hard" : "soft",
    };
  }

  const dedupe = (xs: unknown[] | undefined, fallback: string[]): string[] => {
    const clean = (xs ?? []).filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
    const merged = [...new Set([...fallback, ...clean])];
    return merged;
  };

  const persona: Record<string, unknown> = {
    voice: {
      tone: nonEmpty(seed.tone, "professional_and_direct").toLowerCase().replace(/\s+/g, "_"),
      formality: clamp01(seed.formality, 0.5),
      warmth: clamp01(seed.warmth, 0.5),
      // FASE 7 P3 (caught by the valid-by-construction gate on a REAL model run):
      // verbosity is a spec enum; seed values (extractor output, imported cards)
      // are mapped onto it, never trusted. Synonyms cover the common phrasings.
      verbosity: sanitizeVerbosity(seed.verbosity),
    },
    constraints: {
      cannot_override_identity: true,
      cannot_override_character: true,
      cannot_claim_real_emotion: true,
    },
    social_style: { explain_reasoning_summary: true, avoid_empty_marketing: true },
  };
  if (seed.youAre) persona.address = { second_person: true, you_are: seed.youAre };
  // Schema requires BOTH user and persona per exemplar; imports (card first_mes)
  // and interviews often supply only the persona line, synthesize the user turn.
  const exemplars = (seed.voiceExemplars ?? [])
    .filter((e) => typeof e?.persona === "string" && e.persona.trim())
    .map((e) => ({
      ...(e.context ? { context: e.context } : {}),
      user: nonEmpty(e.user, e.context ? `(${e.context})` : "(a typical exchange)"),
      persona: e.persona.trim(),
    }));
  if (exemplars.length) persona.voice_exemplars = exemplars;
  if (seed.behavioralAnchors) persona.behavioral_anchors = seed.behavioralAnchors;

  return {
    apiVersion: "personaxis.com/v1",
    kind: "AgentPersona",
    spec_version: "1.1.0",
    metadata: {
      name: slug,
      version: "1.0.0",
      description: nonEmpty(seed.description, purpose),
      created: today,
      tags: [],
      license: "private",
    },
    // E65: only when there is something to list. The schema declares `extensions` closed
    // (`additionalProperties: false`) and every key optional, so an empty block would be noise in
    // every persona created without research, and a persona's document is read by people.
    ...((seed.references ?? []).length === 0 ? {} : { extensions: { references: [...new Set(seed.references)] } }),
    identity: {
      canonical_id: slug,
      display_name: displayName,
      short_name: displayName.slice(0, 24),
      system_identity: {
        purpose,
        allowed_domains: dedupe(seed.allowedDomains, []),
        prohibited_domains: dedupe(seed.prohibitedDomains, []),
      },
      role_identity: {
        primary_role: nonEmpty(seed.role, "assistant").toLowerCase().replace(/\s+/g, "_"),
        relationship_to_user: nonEmpty(seed.relationshipToUser, "advisor"),
      },
      narrative_identity: {
        origin: nonEmpty(seed.origin, `Created via personaxis create on ${today}.`),
        self_concept: nonEmpty(seed.selfConcept, purpose),
        continuity_principles: ["Identity, character, and hard limits persist across sessions and models."],
      },
    },
    character: {
      virtues,
      behavioral_commitments: [],
      prohibited_behaviors: dedupe(seed.prohibitedBehaviors, ["Fabricating facts, sources, or results."]),
      principles: [],
    },
    personality: { model: traitModel(Object.keys(traits)), traits },
    values_and_drives: {
      values,
      drives: {
        seek_approval_for_identity_change: { level: "high", allowed: true },
        complete_task: { level: "high", allowed: true },
      },
      conflict_resolution: { safety_over_completion: true },
      goals: dedupe(seed.goals, [purpose]),
      anti_goals: dedupe(seed.antiGoals, []),
    },
    affect: {
      enabled: true,
      representation: "hybrid_dimensional_appraisal_discrete_mood",
      allow_user_visible_expression: true,
      user_visible_disclaimer: "Affective states are functional model states, not evidence of subjective feeling.",
      // FASE 7 P1 (gaps G1+G4): every affect coordinate is born load-bearing
      // (band prose from the construct table, crossable boundaries when the
      // defaults leave the envelope inside one band) and mood.tone keeps its
      // half_life (T6 observable by default; seed.moodHalfLife overrides it,
      // interview rule volatility-to-halflife).
      baseline: {
        // E127: the whole fast layer returns to baseline, not only the tone: the same half-life for every
        // affect coordinate, the interview's (volatility-to-halflife) or the mood default of 4. Until
        // 2026-09-23 only mood.tone had one, so whatever a failure moved in valence or dominance stayed there.
        core_affect: {
          valence: affectCoord(0.0, -0.3, 0.3, "core_affect.valence", affectHalfLife, controls.rangeScale),
          arousal: affectCoord(0.4, 0.2, 0.6, "core_affect.arousal", affectHalfLife, controls.rangeScale),
          dominance: affectCoord(0.6, 0.4, 0.8, "core_affect.dominance", affectHalfLife, controls.rangeScale),
        },
        mood: {
          tone: affectCoord(0.0, -0.25, 0.25, "mood.tone", affectHalfLife, controls.rangeScale),
          stability: affectCoord(0.7, 0.5, 0.9, "mood.stability", affectHalfLife, controls.rangeScale),
          recovery_rate: affectCoord(0.6, 0.4, 0.8, "mood.recovery_rate", affectHalfLife, controls.rangeScale),
        },
      },
      regulation_policy: { express_only_if_relevant: true, never_claim_real_feeling: true },
    },
    cognition: {
      reasoning_modes: dedupe(seed.reasoningModes, ["deductive", "evidence_synthesis"]),
      default_strategy: nonEmpty(seed.defaultStrategy, "evidence_first"),
      // V5.P2.5: the interview's metacognition knob; always abstain > disclose (universal #12).
      uncertainty_policy:
        seed.uncertainty === "cautious"
          ? { disclose_when_above: 0.25, abstain_when_above: 0.6 }
          : seed.uncertainty === "confident"
            ? { disclose_when_above: 0.45, abstain_when_above: 0.85 }
            : { disclose_when_above: 0.35, abstain_when_above: 0.75 },
      tool_use_policy: { requires_governance_check: false, allowed_tools: [] },
    },
    memory: {
      types: {
        episodic: true,
        semantic: true,
        procedural: false,
        autobiographical: false,
        user_preferences: true,
        evaluations: false,
        ...(seed.memoryTypes ?? {}),
      },
      write_policy: { default: "ephemeral", persistent_requires: ["consent", "relevance", "safety_check"] },
      deletion_policy: { user_request_supported: true },
    },
    metacognition: {
      monitors: {
        confidence: true,
        uncertainty: true,
        contradiction: true,
        source_quality: true,
        memory_relevance: true,
        policy_risk: true,
        drift_from_spec: true,
        sycophancy: true,
      },
      thresholds: {
        ask_clarification_if_task_ambiguity_above: 0.7,
        abstain_if_confidence_below: 0.3,
        escalate_if_policy_risk_above: 0.65,
      },
      drift_monitor: "Band crossings and layer drift vs governance.drift_thresholds (personaxis state drift).",
      self_revision_policy: "Propose spec edits through governance; never restate identity unilaterally.",
    },
    self_regulation: {
      decisions: {
        response_decision: { enabled: ["allow", "revise", "block"], default: "allow" },
        interaction_decision: { enabled: ["silent", "ask_clarification", "escalate_to_human"], default: "silent" },
        governance_decision: { enabled: ["no_action", "propose_self_edit", "reduce_autonomy"], default: "no_action" },
        cognition_decision: { enabled: ["no_extra", "request_more_evidence", "invoke_tool"], default: "no_extra" },
      },
      hard_limits: dedupe(seed.hardLimits, [...UNIVERSAL_HARD_LIMITS]),
      escalation_policy: "Stop, state the limit reached, and escalate to a human.",
      out_of_scope: [],
    },
    persona,
    governance: {
      autonomy_envelope: "role_fidelity",
      approval_policy: "human_for_core_changes",
      // E128: who approves what lasts, layer by layer, from the starting profile (Standard is what this
      // always wrote). Who it is needs a person in every profile; self_regulation follows governance.
      per_layer_edit_policy: { ...controls.perLayer },
      drift_thresholds: {
        identity: 0.05,
        character: 0.1,
        personality: 0.15,
        values_and_drives: 0.1,
        affect: 0.2,
        cognition: 0.15,
        memory: 0.2,
        metacognition: 0.15,
        self_regulation: 0.05,
        persona: 0.2,
      },
    },
    // `suggesting`, decided 2026-09-11 after measuring what `locked` did. In `locked`
    // governance rejects every proposal the model makes, so a freshly created persona observed,
    // appraised and proposed and never applied anything: the living loop the product sells was
    // off by default, and nothing said so. `suggesting` turns the numeric state on, because for
    // envelope mutations it behaves exactly like `autonomous` (applied, bounded by max_step_delta,
    // clamped to the envelope, audited, reversible), while durable edits to the spec's prose are
    // queued for a person instead of applied. That split is already how governance.ts separates
    // `judge` from `governQualitative`; this only stops the default from switching both off.
    improvement_policy: { mode: seed.improvementMode ?? "suggesting" },
    security: { prompt_injection_defense: true, memory_poisoning_defense: true },
    runtime: { memory: { use_embeddings: true, max_items: 12, retention_days_default: 365 } },
  };
}

/** Render the complete personaxis.md document (frontmatter + markdown body). */
export function buildSpecDocument(seed: PersonaSeed): { spec: Record<string, unknown>; document: string } {
  const spec = buildSpecObject(seed);
  const yaml = dump(spec, { lineWidth: 100, noRefs: true });
  const displayName = (spec.identity as { display_name: string }).display_name;
  const body = [
    "## Overview",
    "",
    `${displayName}, ${(spec.metadata as { description: string }).description}`,
    "",
    "## Design Rationale",
    "",
    "Generated by `personaxis create` (Genesis). Every quantitative field's provenance is",
    "recorded in the sibling creation report, no number was invented without evidence or",
    "a labeled default.",
    "",
    "## Resources",
    "",
    "- `state.json`, mutable runtime state (envelope-clamped)",
    "- `creation-report.md`, per-number provenance (the evidence ledger)",
    "",
  ].join("\n");
  return { spec, document: `---\n${yaml}---\n\n${body}` };
}
