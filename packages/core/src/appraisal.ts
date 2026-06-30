/**
 * Appraisal signals — what the model proposes, NOT what gets applied.
 *
 * Feasibility-in-small-models design (see plan/04-small-models): the model never
 * emits a valid state mutation by hand. It emits a *structured appraisal signal*
 * under a JSON Schema (enforceable with GBNF / json-schema constrained decoding),
 * and the spec engine performs the clamp + governance. The model proposes
 * signals; the code + the spec impose safety.
 */

export type ProvenanceSource = "user" | "tool" | "internal" | "synthesis";

export interface ProposedMutation {
  /** Dot-notation envelope field, e.g. "mood.tone". */
  field: string;
  /** Signed delta; the engine clamps it to the envelope. */
  delta: number;
  /** One-line rationale (required for audit). */
  reason: string;
}

export interface ProposedMemory {
  /** Short, self-contained note to remember. */
  content: string;
  /** Where the content came from (drives trust + sensitive-action gates). */
  source: ProvenanceSource;
  tags?: string[];
}

/**
 * A proposed QUALITATIVE self-edit to the spec's prose material (governed downstream by
 * improvement_policy.mode + consensus verifiers + the protected-path list). The engine —
 * not the model — decides whether it is queued, applied, or rejected.
 */
export interface ProposedSelfEdit {
  /** Dot-path into the spec; only qualitative prefixes (persona_prompting.*) are honored. */
  targetPath: string;
  /** The proposed new value (string/array/object of prose). */
  toValue: unknown;
  /** One-line justification (required for audit + the rationale verifier). */
  rationale: string;
}

/** A proposed stable user preference (memory.types.user_preferences). */
export interface ProposedPreference {
  key: string;
  value: string;
  rationale?: string;
}

export interface AppraisalSignal {
  /** Free-text appraisal of the current situation (kept short). */
  appraisal: string;
  /** Proposed envelope nudges (clamped + governed downstream). */
  mutations: ProposedMutation[];
  /** Proposed memory writes (verified + lineage-tagged downstream). */
  memories: ProposedMemory[];
  /** Proposed qualitative self-edits to persona_prompting (governed by mode + consensus). */
  selfEdits?: ProposedSelfEdit[];
  /** Proposed stable user preferences (written only when user_preferences is enabled). */
  preferences?: ProposedPreference[];
  /** Model's self-reported confidence in [0,1] (drives abstain/disclose). */
  confidence: number;
}

/**
 * JSON Schema for the appraisal signal. Feed this to the local provider's
 * constrained-decoding backend (llama.cpp json-schema / GBNF, Outlines, XGrammar)
 * so even a <=4B model can only emit a well-formed signal.
 */
export const APPRAISAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["appraisal", "mutations", "memories", "confidence"],
  properties: {
    appraisal: { type: "string", maxLength: 600 },
    mutations: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "delta", "reason"],
        properties: {
          field: { type: "string" },
          delta: { type: "number", minimum: -1, maximum: 1 },
          reason: { type: "string", maxLength: 200 },
        },
      },
    },
    memories: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["content", "source"],
        properties: {
          content: { type: "string", maxLength: 500 },
          source: { type: "string", enum: ["user", "tool", "internal", "synthesis"] },
          tags: { type: "array", items: { type: "string" }, maxItems: 6 },
        },
      },
    },
    selfEdits: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["targetPath", "toValue", "rationale"],
        properties: {
          targetPath: { type: "string" },
          toValue: {},
          rationale: { type: "string", maxLength: 240 },
        },
      },
    },
    preferences: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "value"],
        properties: {
          key: { type: "string" },
          value: { type: "string", maxLength: 200 },
          rationale: { type: "string", maxLength: 200 },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

/**
 * Value-constraint keywords that hosted structured-output backends (Cohere, Groq,
 * some Azure deployments) reject — they accept only a structural subset of JSON
 * Schema. The spec engine re-imposes every one of these downstream (delta clamping
 * + `parseAppraisalSignal` coercion), so dropping them from the *wire* schema costs
 * no safety: the model still proposes, the code + spec still impose.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "maxLength",
  "minLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "maxItems",
  "minItems",
  "pattern",
  "multipleOf",
  "format",
]);

/**
 * Project a JSON Schema down to the portable subset accepted by strict
 * structured-output endpoints: keep structural keywords (`type`, `properties`,
 * `required`, `items`, `enum`, `additionalProperties`), drop value constraints.
 */
export function portableJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(portableJsonSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (UNSUPPORTED_SCHEMA_KEYWORDS.has(k)) continue;
      out[k] = portableJsonSchema(v);
    }
    return out;
  }
  return schema;
}

/** Anything that can turn an observation into an appraisal signal. */
export interface Appraiser {
  appraise(input: AppraiseInput): Promise<AppraisalSignal>;
}

export interface AppraiseInput {
  /** What just happened (provenance-tagged). */
  observation: string;
  source: ProvenanceSource;
  /** The compiled persona document (identity, slot #1). */
  personaBody: string;
  /** Current envelope fields the model may nudge. */
  mutableFields: string[];
  /** Top-level spec sections the persona MAY propose qualitative self-edits to (editGate != block). */
  editableSections?: string[];
}

/** Defensive parser: coerce arbitrary JSON into a valid AppraisalSignal. */
export function parseAppraisalSignal(raw: unknown): AppraisalSignal {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mutations = Array.isArray(o.mutations) ? o.mutations : [];
  const memories = Array.isArray(o.memories) ? o.memories : [];
  const selfEdits = Array.isArray(o.selfEdits) ? o.selfEdits : [];
  const preferences = Array.isArray(o.preferences) ? o.preferences : [];
  return {
    appraisal: typeof o.appraisal === "string" ? o.appraisal : "",
    confidence:
      typeof o.confidence === "number" && o.confidence >= 0 && o.confidence <= 1
        ? o.confidence
        : 0.5,
    mutations: mutations
      .map((m) => m as Record<string, unknown>)
      .filter((m) => typeof m.field === "string" && typeof m.delta === "number")
      .map((m) => ({
        field: m.field as string,
        delta: m.delta as number,
        reason: typeof m.reason === "string" ? m.reason : "appraisal nudge",
      })),
    memories: memories
      .map((m) => m as Record<string, unknown>)
      .filter((m) => typeof m.content === "string")
      .map((m) => ({
        content: m.content as string,
        source: isSource(m.source) ? m.source : "internal",
        tags: Array.isArray(m.tags) ? (m.tags as string[]).filter((t) => typeof t === "string") : [],
      })),
    selfEdits: selfEdits
      .map((s) => s as Record<string, unknown>)
      .filter((s) => typeof s.targetPath === "string" && "toValue" in s && typeof s.rationale === "string")
      .map((s) => ({ targetPath: s.targetPath as string, toValue: s.toValue, rationale: s.rationale as string })),
    preferences: preferences
      .map((p) => p as Record<string, unknown>)
      .filter((p) => typeof p.key === "string" && typeof p.value === "string")
      .map((p) => ({ key: p.key as string, value: p.value as string, ...(typeof p.rationale === "string" ? { rationale: p.rationale } : {}) })),
  };
}

function isSource(v: unknown): v is ProvenanceSource {
  return v === "user" || v === "tool" || v === "internal" || v === "synthesis";
}
