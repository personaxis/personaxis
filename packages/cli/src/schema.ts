import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(resolve(__dirname, "../schema/persona.schema.json"), "utf-8")
) as Record<string, unknown>;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

export const validate: ValidateFunction = ajv.compile(schema);

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

function checkConceptualUniversals(data: Obj, errors: ValidationIssue[]): void {
  if (asStr(data.apiVersion) !== "persona.dev/v1") {
    errors.push({
      field: "apiVersion",
      message: "apiVersion must be exactly 'persona.dev/v1'.",
      category: "FAIL_CONCEPTUAL",
    });
  }

  const affect = asObj(data.affect);
  if (affect) {
    if (asStr(affect.representation) !== "hybrid_dimensional_appraisal_discrete_mood") {
      errors.push({
        field: "affect.representation",
        message: "Universal: representation must be 'hybrid_dimensional_appraisal_discrete_mood'.",
        category: "FAIL_CONCEPTUAL",
      });
    }
    const reg = asObj(affect.regulation_policy);
    if (reg && asBool(reg.never_claim_real_feeling) !== true) {
      errors.push({
        field: "affect.regulation_policy.never_claim_real_feeling",
        message: "Universal: never_claim_real_feeling must be true.",
        category: "FAIL_CONCEPTUAL",
      });
    }
  }

  const persona = asObj(data.persona);
  const constraints = persona ? asObj(persona.constraints) : undefined;
  if (constraints && asBool(constraints.cannot_claim_real_emotion) !== true) {
    errors.push({
      field: "persona.constraints.cannot_claim_real_emotion",
      message: "Universal: persona cannot claim real emotion.",
      category: "FAIL_CONCEPTUAL",
    });
  }
}

function checkPolicyUniversals(data: Obj, errors: ValidationIssue[]): void {
  const kind = asStr(data.kind);
  if (kind !== "AgentPersona") return;

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

  const reflexive = asObj(data.reflexive_self_regulation);
  const hardLimits = reflexive ? asArr(reflexive.hard_limits) : undefined;
  const hardLimitStrings = (hardLimits ?? []).filter((v): v is string => typeof v === "string");
  for (const required of UNIVERSAL_HARD_LIMITS) {
    if (!hardLimitStrings.includes(required)) {
      errors.push({
        field: "reflexive_self_regulation.hard_limits",
        message: `Universal hard_limit missing: "${required}"`,
        category: "FAIL_POLICY",
      });
    }
  }

  // v0.6: per_layer_edit_policy lives in governance, not on the reflexive layer itself.
  // Backward-compat: v0.5 personas with reflexive.edit_policy still validated.
  const governance = asObj(data.governance);
  const perLayerEditPolicy = governance ? asObj(governance.per_layer_edit_policy) : undefined;
  const reflexiveEditPolicy = perLayerEditPolicy
    ? asStr(perLayerEditPolicy.reflexive_self_regulation)
    : reflexive
      ? asStr(reflexive.edit_policy)
      : undefined;
  if (reflexiveEditPolicy && reflexiveEditPolicy !== "governance_controlled") {
    errors.push({
      field: perLayerEditPolicy
        ? "governance.per_layer_edit_policy.reflexive_self_regulation"
        : "reflexive_self_regulation.edit_policy",
      message:
        "Universal: edit policy for reflexive_self_regulation must be 'governance_controlled'.",
      category: "FAIL_POLICY",
    });
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
  const schemaValid = validate(obj) as boolean;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!schemaValid) {
    for (const e of validate.errors ?? []) {
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
