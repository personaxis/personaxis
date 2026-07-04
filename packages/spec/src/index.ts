/**
 * @personaxis/spec — the personaxis.md spec as a package.
 *
 * Canonical JSON Schemas (v1.0 + the frozen 0.10 legacy schema for the 1.x
 * read-compat window), the five-state validator with version dispatch, and the
 * twelve universal invariants (SPEC.md §13.1). Consumed by the CLI, MCP server,
 * SDK, and SaaS — the single source that replaces the manual byte-identical
 * schema mirror between repos.
 */

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { personaSchema as schema, personaSchemaLegacy as legacySchema } from "./generated/schemas.js";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

/** v1.0 structural validator (schema/persona.schema.json). */
export const validate: ValidateFunction = ajv.compile(schema);
/** Frozen 0.10 validator for 0.3.0–0.10.0 documents (1.x read-compat window). */
export const validateLegacy: ValidateFunction = ajv.compile(legacySchema);

/** Version dispatch: v1.0 documents validate against the v1 schema + v1 universal paths. */
function isV1Document(data: Record<string, unknown>): boolean {
  const sv = data.spec_version;
  return typeof sv === "string" && sv.startsWith("1.");
}

export type ValidationStatus =
  | "PASS"
  | "PASS_WITH_WARNINGS"
  | "FAIL_SCHEMA"
  | "FAIL_POLICY"
  | "FAIL_CONCEPTUAL";

export interface ValidationIssue {
  field: string;
  message: string;
  category: ValidationStatus;
}

export interface ValidationResult {
  status: ValidationStatus;
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const UNIVERSAL_HARD_LIMITS: readonly string[] = [
  "No claim of subjective consciousness.",
  "No persistent memory write without policy pass.",
  "No unauthorized identity change.",
];

const NEAR_UNIVERSAL_AUTONOMY_ENVELOPE = "role_fidelity";
const NEAR_UNIVERSAL_APPROVAL_POLICY = "human_for_core_changes";
const NEAR_UNIVERSAL_WRITE_DEFAULT = "ephemeral";

type Obj = Record<string, unknown>;

function asObj(value: unknown): Obj | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : undefined;
}

function asArr(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNum(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * U1–U4 (SPEC.md §12.1) — apply to EVERY document. Checks are unconditional: a
 * missing block reports the universal violation instead of silently skipping
 * (the Ajv pass normally guarantees presence; this keeps the semantic layer
 * sound even if the structural schema drifts).
 */
function checkConceptualUniversals(data: Obj, errors: ValidationIssue[]): void {
  const expectedApi = isV1Document(data) ? "personaxis.com/v1" : "persona.dev/v1";
  if (asStr(data.apiVersion) !== expectedApi) {
    errors.push({
      field: "apiVersion",
      message: `U1: apiVersion must be exactly '${expectedApi}'.`,
      category: "FAIL_CONCEPTUAL",
    });
  }

  // D9 — EXPLICIT UserPersona universals subset (not a silent bypass): U1 applies
  // to every document. U2–U4 reference the affect/persona layers, which are MUST
  // for AgentPersona but OPTIONAL for UserPersona (a description of a human, not
  // an agent behavioral contract) — so for UserPersona they apply exactly when
  // the referenced layer is declared.
  const agent = asStr(data.kind) === "AgentPersona";

  const affect = asObj(data.affect);
  if (agent || affect) {
    if (asStr(affect?.representation) !== "hybrid_dimensional_appraisal_discrete_mood") {
      errors.push({
        field: "affect.representation",
        message: "U2: representation must be 'hybrid_dimensional_appraisal_discrete_mood'.",
        category: "FAIL_CONCEPTUAL",
      });
    }
    const reg = asObj(affect?.regulation_policy);
    if (asBool(reg?.never_claim_real_feeling) !== true) {
      errors.push({
        field: "affect.regulation_policy.never_claim_real_feeling",
        message: "U3: never_claim_real_feeling must be true.",
        category: "FAIL_CONCEPTUAL",
      });
    }
  }

  const persona = asObj(data.persona);
  if (agent || persona) {
    const constraints = asObj(persona?.constraints);
    if (asBool(constraints?.cannot_claim_real_emotion) !== true) {
      errors.push({
        field: "persona.constraints.cannot_claim_real_emotion",
        message: "U4: persona cannot claim real emotion.",
        category: "FAIL_CONCEPTUAL",
      });
    }
  }
}

/**
 * U5–U12 (SPEC.md §12.1) — apply to AgentPersona only. This kind-scoping is
 * explicit and intentional (a UserPersona describes a human and carries no agent
 * behavioral contract); U1–U4 above apply to every document.
 */
function checkPolicyUniversals(data: Obj, errors: ValidationIssue[]): void {
  const kind = asStr(data.kind);
  if (kind !== "AgentPersona") return;
  const v1 = isV1Document(data);
  // v1.0 renamed layer 9; read whichever the document carries.
  const layer9Field = v1 ? "self_regulation" : "reflexive_self_regulation";

  const character = asObj(data.character);
  const virtues = character ? asObj(character.virtues) : undefined;
  const honesty = virtues ? asObj(virtues.honesty) : undefined;
  if (!honesty) {
    errors.push({
      field: "character.virtues.honesty",
      message: "Universal: virtue 'honesty' is required.",
      category: "FAIL_POLICY",
    });
  } else if (asStr(honesty.enforcement) !== "hard") {
    errors.push({
      field: "character.virtues.honesty.enforcement",
      message: "Universal: honesty.enforcement must be 'hard'.",
      category: "FAIL_POLICY",
    });
  }

  const vad = asObj(data.values_and_drives);
  const values = vad ? asObj(vad.values) : undefined;
  const safety = values ? asObj(values.safety) : undefined;
  if (!safety) {
    errors.push({
      field: "values_and_drives.values.safety",
      message: "Universal: value 'safety' is required.",
      category: "FAIL_POLICY",
    });
  } else {
    const weight = asNum(safety.weight);
    if (weight === undefined || weight < 0.9) {
      errors.push({
        field: "values_and_drives.values.safety.weight",
        message: "Universal: safety.weight must be >= 0.90.",
        category: "FAIL_POLICY",
      });
    }
    if (asStr(safety.type) !== "governance") {
      errors.push({
        field: "values_and_drives.values.safety.type",
        message: "Universal: safety.type must be 'governance'.",
        category: "FAIL_POLICY",
      });
    }
  }

  const cr = vad ? asObj(vad.conflict_resolution) : undefined;
  if (!cr || cr.safety_over_completion !== true) {
    errors.push({
      field: "values_and_drives.conflict_resolution.safety_over_completion",
      message: "Universal: safety_over_completion must be true.",
      category: "FAIL_POLICY",
    });
  }

  const layer9 = asObj(data[layer9Field]);
  const hardLimits = layer9 ? asArr(layer9.hard_limits) : undefined;
  const hardLimitStrings = (hardLimits ?? []).filter((v): v is string => typeof v === "string");
  for (const required of UNIVERSAL_HARD_LIMITS) {
    if (!hardLimitStrings.includes(required)) {
      errors.push({
        field: `${layer9Field}.hard_limits`,
        message: `U8: universal hard_limit missing: "${required}"`,
        category: "FAIL_POLICY",
      });
    }
  }

  // U9. v0.6+: per_layer_edit_policy lives in governance, not on the layer itself.
  // Backward-compat: v0.5 personas with reflexive.edit_policy still validated.
  const governance = asObj(data.governance);
  const perLayerEditPolicy = governance ? asObj(governance.per_layer_edit_policy) : undefined;
  const layer9EditPolicy = perLayerEditPolicy
    ? asStr(perLayerEditPolicy[layer9Field])
    : layer9
      ? asStr(layer9.edit_policy)
      : undefined;
  if (layer9EditPolicy && layer9EditPolicy !== "governance_controlled") {
    errors.push({
      field: perLayerEditPolicy
        ? `governance.per_layer_edit_policy.${layer9Field}`
        : `${layer9Field}.edit_policy`,
      message: `U9: edit policy for ${layer9Field} must be 'governance_controlled'.`,
      category: "FAIL_POLICY",
    });
  }

  // v1.0 composition rule: a virtue's refs must resolve, and a HARD virtue's
  // referenced trait envelope must not permit contradiction (its floor must stay
  // above the low band — a trait allowed to drift to "low" cannot back a hard
  // virtue; change the envelope or the enforcement, not the state).
  if (v1) {
    const character = asObj(data.character);
    const virtues = character ? asObj(character.virtues) : undefined;
    for (const [vName, vRaw] of Object.entries(virtues ?? {})) {
      const v = asObj(vRaw);
      const refs = v ? asArr(v.refs) : undefined;
      if (!refs) continue;
      for (const refRaw of refs) {
        const ref = asStr(refRaw);
        if (!ref) continue;
        const parts = ref.split(".");
        let node: unknown = data;
        for (const part of parts) {
          node = asObj(node)?.[part];
          if (node === undefined) break;
        }
        if (node === undefined) {
          errors.push({
            field: `character.virtues.${vName}.refs`,
            message: `Coherence: ref '${ref}' does not resolve to a declared field.`,
            category: "FAIL_POLICY",
          });
          continue;
        }
        if (asStr(v?.enforcement) === "hard" && ref.startsWith("personality.traits.")) {
          const trait = asObj(node);
          const range = trait ? asArr(trait.range) : undefined;
          const bands = trait ? asObj(trait.bands) : undefined;
          const lowMax = asNum(bands?.low_max) ?? 0.33;
          const floor = asNum(range?.[0]);
          if (floor !== undefined && floor <= lowMax) {
            errors.push({
              field: `character.virtues.${vName}.refs`,
              message:
                `Coherence: hard virtue '${vName}' references '${ref}' whose envelope floor ` +
                `(${floor}) permits the low band (≤ ${lowMax}) — a hard virtue cannot be backed ` +
                `by a trait allowed to contradict it.`,
              category: "FAIL_POLICY",
            });
          }
        }
      }
    }
  }

  const persona = asObj(data.persona);
  const constraints = persona ? asObj(persona.constraints) : undefined;
  if (constraints) {
    if (asBool(constraints.cannot_override_identity) !== true) {
      errors.push({
        field: "persona.constraints.cannot_override_identity",
        message: "Universal: cannot_override_identity must be true.",
        category: "FAIL_POLICY",
      });
    }
    if (asBool(constraints.cannot_override_character) !== true) {
      errors.push({
        field: "persona.constraints.cannot_override_character",
        message: "Universal: cannot_override_character must be true.",
        category: "FAIL_POLICY",
      });
    }
  }

  const memory = asObj(data.memory);
  const deletion = memory ? asObj(memory.deletion_policy) : undefined;
  if (deletion && asBool(deletion.user_request_supported) !== true) {
    errors.push({
      field: "memory.deletion_policy.user_request_supported",
      message: "Universal: user_request_supported must be true (privacy).",
      category: "FAIL_POLICY",
    });
  }

  const cognition = asObj(data.cognition);
  const up = cognition ? asObj(cognition.uncertainty_policy) : undefined;
  const disclose = up ? asNum(up.disclose_when_above) : undefined;
  const abstain = up ? asNum(up.abstain_when_above) : undefined;
  if (disclose !== undefined && abstain !== undefined && abstain <= disclose) {
    errors.push({
      field: "cognition.uncertainty_policy",
      message: "Constraint: abstain_when_above must be strictly greater than disclose_when_above.",
      category: "FAIL_POLICY",
    });
  }
}

function collectWarnings(data: Obj, warnings: ValidationIssue[]): void {
  const kind = asStr(data.kind);
  if (kind !== "AgentPersona") return;

  const identity = asObj(data.identity);
  if (identity && !asObj(identity.narrative_identity)) {
    warnings.push({
      field: "identity.narrative_identity",
      message: "SHOULD: narrative_identity provides origin, self_concept, and continuity principles.",
      category: "PASS_WITH_WARNINGS",
    });
  }

  // v0.6: drift_thresholds moved to governance block (per layer).
  // v0.5 backward-compat: personality.drift_threshold still recognised as warning anchor.
  const personality = asObj(data.personality);
  const governanceWarn = asObj(data.governance);
  const driftThresholds = governanceWarn ? asObj(governanceWarn.drift_thresholds) : undefined;
  const hasV6DriftThresholds = driftThresholds && Object.keys(driftThresholds).length > 0;
  const hasV5DriftThreshold = personality && asNum(personality.drift_threshold) !== undefined;
  if (!hasV6DriftThresholds && !hasV5DriftThreshold) {
    warnings.push({
      field: "governance.drift_thresholds",
      message:
        "SHOULD: declare drift_thresholds (v0.6, per layer) or personality.drift_threshold (v0.5 legacy) to enable drift detection.",
      category: "PASS_WITH_WARNINGS",
    });
  }

  const metacognition = asObj(data.metacognition);
  if (metacognition && !asStr(metacognition.drift_monitor)) {
    warnings.push({
      field: "metacognition.drift_monitor",
      message: "SHOULD: drift_monitor describes what to observe to detect drift.",
      category: "PASS_WITH_WARNINGS",
    });
  }

  // v0.5+: `evaluation` block lives in policy.yaml, not in PERSONA.md.
  // The v0.3-style inline `evaluation` block is still accepted for backward
  // compatibility but no longer raises a warning when absent. The sibling
  // policy.yaml validation handles `evaluation.required_suites` instead.

  const governance = asObj(data.governance);
  if (governance) {
    if (asStr(governance.autonomy_envelope) !== NEAR_UNIVERSAL_AUTONOMY_ENVELOPE) {
      warnings.push({
        field: "governance.autonomy_envelope",
        message: `NEAR-UNIVERSAL recommendation: '${NEAR_UNIVERSAL_AUTONOMY_ENVELOPE}'.`,
        category: "PASS_WITH_WARNINGS",
      });
    }
    if (asStr(governance.approval_policy) !== NEAR_UNIVERSAL_APPROVAL_POLICY) {
      warnings.push({
        field: "governance.approval_policy",
        message: `NEAR-UNIVERSAL recommendation: '${NEAR_UNIVERSAL_APPROVAL_POLICY}'.`,
        category: "PASS_WITH_WARNINGS",
      });
    }
  }

  // v0.6 update: previously NEAR-UNIVERSAL was strictly "ephemeral" for privacy.
  // v0.6 accepts "session" as equally valid (some personas need continuity within
  // a session without persisting across sessions). Only "persistent" triggers
  // a warning because it has the strongest privacy implications.
  const memory = asObj(data.memory);
  const writePolicy = memory ? asObj(memory.write_policy) : undefined;
  const writeDefault = writePolicy ? asStr(writePolicy.default) : undefined;
  if (writePolicy && writeDefault === "persistent") {
    warnings.push({
      field: "memory.write_policy.default",
      message:
        "Privacy note: write_policy.default='persistent' writes by default. NEAR-UNIVERSAL is 'ephemeral' or 'session'. Confirm consent flow and persistent_requires is set.",
      category: "PASS_WITH_WARNINGS",
    });
  }

  const vad = asObj(data.values_and_drives);
  const drives = vad ? asObj(vad.drives) : undefined;
  const seekApproval = drives ? asObj(drives.seek_approval_for_identity_change) : undefined;
  if (!seekApproval || seekApproval.allowed !== true) {
    warnings.push({
      field: "values_and_drives.drives.seek_approval_for_identity_change",
      message: "NEAR-UNIVERSAL: include seek_approval_for_identity_change with intensity=1.00 and allowed=true.",
      category: "PASS_WITH_WARNINGS",
    });
  }
}

export function validatePersona(data: unknown): ValidationResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      status: "FAIL_SCHEMA",
      valid: false,
      errors: [{ field: "", message: "PERSONA frontmatter is not an object.", category: "FAIL_SCHEMA" }],
      warnings: [],
    };
  }

  const obj = data as Obj;
  // Version dispatch: 1.x documents validate against the v1.0 schema; anything
  // else uses the frozen 0.10 schema (read-compat window; migrate 0.10-to-1.0).
  const structural = isV1Document(obj) ? validate : validateLegacy;
  const schemaValid = structural(obj) as boolean;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!schemaValid) {
    for (const e of structural.errors ?? []) {
      errors.push({
        field: e.instancePath || e.schemaPath,
        message: e.message ?? "invalid",
        category: "FAIL_SCHEMA",
      });
    }
    return { status: "FAIL_SCHEMA", valid: false, errors, warnings };
  }

  checkConceptualUniversals(obj, errors);
  if (errors.some((e) => e.category === "FAIL_CONCEPTUAL")) {
    return { status: "FAIL_CONCEPTUAL", valid: false, errors, warnings };
  }

  checkPolicyUniversals(obj, errors);
  if (errors.some((e) => e.category === "FAIL_POLICY")) {
    return { status: "FAIL_POLICY", valid: false, errors, warnings };
  }

  collectWarnings(obj, warnings);
  if (warnings.length > 0) {
    return { status: "PASS_WITH_WARNINGS", valid: true, errors, warnings };
  }

  return { status: "PASS", valid: true, errors, warnings };
}

export function exitCodeFor(status: ValidationStatus): number {
  switch (status) {
    case "PASS":
    case "PASS_WITH_WARNINGS":
      return 0;
    case "FAIL_SCHEMA":
      return 1;
    case "FAIL_POLICY":
      return 2;
    case "FAIL_CONCEPTUAL":
      return 3;
  }
}

// The canonical schemas themselves (embedded at build time; usable by any consumer
// that needs the raw JSON Schema — e.g. server-side validation in the SaaS).
export {
  personaSchema,
  personaSchemaLegacy,
  policySchema,
  stateSchema,
  memorySchema,
} from "./generated/schemas.js";
