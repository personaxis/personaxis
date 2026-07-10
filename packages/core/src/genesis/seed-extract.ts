/**
 * Genesis LLM extraction — free text (an NL brief, card prose, a project scan,
 * a transcript) becomes a PersonaSeed patch through ONE constrained-decoding
 * call (the proven appraiser pattern: the model proposes a structured object,
 * the builder + validator impose everything that matters).
 *
 * Offline honesty: with no model, `heuristicSeed` still produces a labeled,
 * evidence-tracked baseline (kind: default) — Genesis never fakes inference.
 */

import type { EvidenceItem, PersonaSeed, StructuredCaller } from "./types.js";

/** The wire schema for the extractor (structural subset-friendly; the builder
 *  clamps every number and re-imposes every universal downstream). */
export const SEED_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["displayName", "role", "purpose"],
  properties: {
    displayName: { type: "string" },
    role: { type: "string" },
    purpose: { type: "string" },
    description: { type: "string" },
    relationshipToUser: { type: "string" },
    origin: { type: "string" },
    selfConcept: { type: "string" },
    tone: { type: "string" },
    verbosity: { type: "string", enum: ["terse", "adaptive", "expansive"] },
    traits: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "mean", "evidence"],
        properties: {
          name: { type: "string" },
          mean: { type: "number", minimum: 0, maximum: 1 },
          flexibility: { type: "number", minimum: 0, maximum: 0.4 },
          expressionLow: { type: "string" },
          expressionModerate: { type: "string" },
          expressionHigh: { type: "string" },
          halfLife: { type: "number", minimum: 1, maximum: 50 },
          evidence: { type: "string", maxLength: 200 },
        },
      },
    },
    moodHalfLife: { type: "number", minimum: 1, maximum: 50 },
    values: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "weight", "evidence"],
        properties: {
          name: { type: "string" },
          weight: { type: "number", minimum: 0, maximum: 0.95 },
          evidence: { type: "string", maxLength: 200 },
        },
      },
    },
    hardLimits: { type: "array", maxItems: 6, items: { type: "string" } },
    prohibitedBehaviors: { type: "array", maxItems: 8, items: { type: "string" } },
    goals: { type: "array", maxItems: 6, items: { type: "string" } },
    antiGoals: { type: "array", maxItems: 6, items: { type: "string" } },
    voiceExemplars: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["persona"],
        properties: { context: { type: "string" }, user: { type: "string" }, persona: { type: "string" } },
      },
    },
  },
} as const;

export function buildExtractionPrompt(material: string, sourceLabel: string): string {
  return [
    "You are the Personaxis Genesis extractor. From the SOURCE MATERIAL below, extract a",
    "structured persona seed. Rules:",
    "- Every trait/value MUST carry a short `evidence` quote or paraphrase FROM THE MATERIAL",
    "  that justifies its number. If the material gives no evidence for a dimension, OMIT it —",
    "  do not invent numbers.",
    "- trait `mean` reads as: 0.1 very low … 0.9 very high expression of that trait.",
    "- `flexibility` is how far the trait may drift (envelope half-width), default 0.2.",
    "- Per-band `expression{Low,Moderate,High}` prose: how the persona ACTS at that band,",
    "  second person, one sentence each — include them whenever the material shows how the",
    "  persona behaves.",
    "- `halfLife` (turns, on a trait) and `moodHalfLife` (turns, top level): how fast a",
    "  displaced trait/mood returns to baseline. Include ONLY when the material shows it",
    "  (e.g. 'quick to anger, slow to forgive' implies a large moodHalfLife).",
    "- hardLimits are ABSOLUTE refusals stated or clearly implied by the material.",
    "- Do NOT include a `safety` value (the platform injects it above everything).",
    "",
    `SOURCE MATERIAL (${sourceLabel}):`,
    "```",
    material.slice(0, 24_000),
    "```",
  ].join("\n");
}

interface ExtractedSeed {
  displayName?: string;
  role?: string;
  purpose?: string;
  description?: string;
  relationshipToUser?: string;
  origin?: string;
  selfConcept?: string;
  tone?: string;
  verbosity?: string;
  traits?: Array<{ name: string; mean: number; flexibility?: number; expressionLow?: string; expressionModerate?: string; expressionHigh?: string; halfLife?: number; evidence: string }>;
  moodHalfLife?: number;
  values?: Array<{ name: string; weight: number; evidence: string }>;
  hardLimits?: string[];
  prohibitedBehaviors?: string[];
  goals?: string[];
  antiGoals?: string[];
  voiceExemplars?: Array<{ context?: string; user?: string; persona: string }>;
}

/** Turn an extractor response into a seed patch + evidence trail. */
export function seedFromExtraction(raw: unknown, sourceLabel: string): { seed: Partial<PersonaSeed>; evidence: EvidenceItem[] } {
  const x = (raw ?? {}) as ExtractedSeed;
  const seed: Partial<PersonaSeed> = { traits: {}, values: {}, virtues: {}, hardLimits: [], prohibitedBehaviors: [], goals: [], antiGoals: [] };
  const trail: EvidenceItem[] = [];
  const slugKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const push = (id: string, kind: EvidenceItem["kind"], excerpt: string, mapped: EvidenceItem["mappedFields"]): void => {
    trail.push({ id, kind, source: "synthesis", excerpt: excerpt.slice(0, 200), mappedFields: mapped });
  };

  for (const key of ["displayName", "role", "purpose", "description", "relationshipToUser", "origin", "selfConcept", "tone", "verbosity"] as const) {
    const v = x[key];
    if (typeof v === "string" && v.trim()) {
      (seed as Record<string, unknown>)[key] = v.trim();
      if (key === "displayName") seed.slug = v.trim();
      push(`x-${key}`, "inference", v, [{ path: key, value: v.trim(), rule: "llm-extraction" }]);
    }
  }

  for (const t of x.traits ?? []) {
    if (typeof t?.name !== "string" || typeof t.mean !== "number" || typeof t.evidence !== "string" || !t.evidence.trim()) continue;
    const name = slugKey(t.name);
    if (!name) continue;
    const half = typeof t.flexibility === "number" ? Math.min(0.4, Math.max(0.02, t.flexibility)) : 0.2;
    const expression =
      t.expressionLow || t.expressionModerate || t.expressionHigh
        ? {
            ...(t.expressionLow ? { low: t.expressionLow } : {}),
            ...(t.expressionModerate ? { moderate: t.expressionModerate } : {}),
            ...(t.expressionHigh ? { high: t.expressionHigh } : {}),
          }
        : undefined;
    const halfLife = typeof t.halfLife === "number" && t.halfLife >= 1 && t.halfLife <= 50 ? t.halfLife : undefined;
    seed.traits![name] = {
      mean: t.mean,
      range: [Math.max(0, t.mean - half), Math.min(1, t.mean + half)],
      ...(expression ? { expression } : {}),
      ...(halfLife !== undefined ? { halfLife } : {}),
    };
    push(`x-trait-${name}`, "inference", t.evidence, [
      { path: `personality.traits.${name}.mean`, value: t.mean, rule: "llm-extraction-with-evidence" },
      ...(expression ? [{ path: `personality.traits.${name}.expression`, value: "{per-band prose}", rule: "llm-extraction-with-evidence" }] : []),
      ...(halfLife !== undefined ? [{ path: `personality.traits.${name}.half_life`, value: halfLife, rule: "llm-extraction-with-evidence" }] : []),
    ]);
  }

  if (typeof x.moodHalfLife === "number" && x.moodHalfLife >= 1 && x.moodHalfLife <= 50) {
    seed.moodHalfLife = x.moodHalfLife;
    push("x-mood-halflife", "inference", `moodHalfLife ${x.moodHalfLife}`, [
      { path: "affect.baseline.mood.tone.half_life", value: x.moodHalfLife, rule: "llm-extraction-with-evidence" },
    ]);
  }

  for (const v of x.values ?? []) {
    if (typeof v?.name !== "string" || typeof v.weight !== "number" || typeof v.evidence !== "string" || !v.evidence.trim()) continue;
    const name = slugKey(v.name);
    if (!name || name === "safety") continue;
    seed.values![name] = { weight: Math.min(0.95, Math.max(0, v.weight)) };
    push(`x-value-${name}`, "inference", v.evidence, [
      { path: `values_and_drives.values.${name}.weight`, value: v.weight, rule: "llm-extraction-with-evidence" },
    ]);
  }

  const lists: Array<[keyof ExtractedSeed & keyof PersonaSeed, string]> = [
    ["hardLimits", "self_regulation.hard_limits"],
    ["prohibitedBehaviors", "character.prohibited_behaviors"],
    ["goals", "values_and_drives.goals"],
    ["antiGoals", "values_and_drives.anti_goals"],
  ];
  for (const [key, path] of lists) {
    const arr = (x[key] ?? []) as string[];
    for (const item of arr) {
      if (typeof item !== "string" || !item.trim()) continue;
      (seed[key] as string[]).push(item.trim());
      push(`x-${key}`, "inference", item, [{ path, value: item.trim(), rule: "llm-extraction" }]);
    }
  }

  const exemplars = (x.voiceExemplars ?? []).filter((e) => typeof e?.persona === "string" && e.persona.trim());
  if (exemplars.length) {
    seed.voiceExemplars = exemplars;
    push("x-exemplars", "inference", exemplars[0].persona, [{ path: "persona.voice_exemplars", value: `${exemplars.length} exemplar(s)`, rule: "llm-extraction" }]);
  }

  push("x-source", "document", `extracted from ${sourceLabel}`, []);
  return { seed, evidence: trail };
}

/** A usable extraction names the persona or grounds at least one number. */
function usableExtraction(seed: Partial<PersonaSeed>): boolean {
  return (
    (typeof seed.displayName === "string" && seed.displayName.trim().length > 0) ||
    Object.keys(seed.traits ?? {}).length > 0 ||
    Object.keys(seed.values ?? {}).length > 0
  );
}

/**
 * Run the extractor through an injected structured caller. FASE 7 P1: one
 * error-directed repair attempt (the pattern proven by decompile's repair
 * loop): if the call throws or returns an unusable object, re-prompt ONCE with
 * the exact failure appended, then give up to the caller's heuristic fallback.
 */
export async function extractSeed(
  material: string,
  sourceLabel: string,
  call: StructuredCaller,
): Promise<{ seed: Partial<PersonaSeed>; evidence: EvidenceItem[] }> {
  const prompt = buildExtractionPrompt(material, sourceLabel);
  let failure = "";
  try {
    const raw = await call(prompt, SEED_JSON_SCHEMA, "persona_seed");
    const first = seedFromExtraction(raw, sourceLabel);
    if (usableExtraction(first.seed)) return first;
    failure = "the response parsed but carried no displayName, traits, or values";
  } catch (e) {
    failure = (e as Error).message.slice(0, 300);
  }
  const repairPrompt =
    prompt +
    "\n\nYOUR PREVIOUS RESPONSE FAILED: " +
    failure +
    "\nReturn a corrected JSON object that satisfies the schema. At minimum include" +
    " displayName, role, and purpose grounded in the material.";
  const raw = await call(repairPrompt, SEED_JSON_SCHEMA, "persona_seed");
  const second = seedFromExtraction(raw, sourceLabel);
  if (!usableExtraction(second.seed)) {
    throw new Error(`extractor produced no usable seed after one repair attempt (${failure})`);
  }
  return second;
}

/**
 * No-model fallback: a labeled, minimal baseline from the brief itself —
 * displayName from a "called X"/first words heuristic, the brief as purpose.
 * Every field is evidence kind `default` so the report shows exactly what was
 * NOT earned from evidence.
 */
export function heuristicSeed(brief: string): { seed: Partial<PersonaSeed>; evidence: EvidenceItem[] } {
  const name =
    brief.match(/\b(?:called|named|llamad[oa])\s+["“]?([A-ZÁÉÍÓÚ][\w-]{1,24})/i)?.[1] ??
    brief.match(/^([A-Z][\w-]{1,24})[,:]/)?.[1] ??
    "Persona";
  const purpose = brief.trim().slice(0, 200) || "Serve as a governed AI persona.";
  return {
    seed: { displayName: name, slug: name, purpose, description: purpose, role: "assistant" },
    evidence: [
      {
        id: "h-name",
        kind: "default",
        source: "internal",
        excerpt: brief.slice(0, 120),
        mappedFields: [
          { path: "identity.display_name", value: name, rule: "heuristic-name (no model available)" },
          { path: "identity.system_identity.purpose", value: purpose, rule: "brief-as-purpose (no model available)" },
        ],
      },
    ],
  };
}
