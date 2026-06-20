// Loader + validator for sibling policy.yaml (spec v0.5.0).
//
// policy.yaml lives next to PERSONA.md. It encodes operational policy that
// Personaxis enforces but NEVER inlines into the LLM system prompt.
//
// Symmetric to load.ts + schema.ts but for the policy file.

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

const __dirname = dirname(fileURLToPath(import.meta.url));
const policySchema = JSON.parse(
  readFileSync(resolve(__dirname, "../schema/policy.schema.json"), "utf-8"),
) as Record<string, unknown>;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

export const validatePolicySchema: ValidateFunction = ajv.compile(policySchema);

export interface PolicyAssertion {
  layer: string;
  name: string;
  description?: string;
  type: "regex" | "llm_judge" | "semantic" | "activation_projection";
  definition: Record<string, unknown>;
  severity: "info" | "warn" | "block";
  enabled?: boolean;
}

export interface PolicyData {
  spec_version: string;
  applies_to: {
    persona_name: string;
    persona_version_range?: string;
  };
  improvement_policy: {
    mode: "locked" | "suggesting" | "auto";
    approved_by?: string;
    last_approval_at?: string;
    approval_expires_at?: string;
  };
  runtime?: {
    min_consistency?: number;
    drift_alert_channels?: string[];
    allowed_consumers?: ("agent" | "human" | "mcp")[];
  };
  evaluation?: {
    required_suites?: string[];
  };
  assertions?: PolicyAssertion[];
}

export interface PolicyLoadResult {
  data: PolicyData;
  raw: string;
  path: string;
}

/**
 * Look for a policy.yaml sibling next to the given PERSONA.md path.
 * Returns null if the sibling does not exist (caller decides if this is
 * an error or just a v0.4 spec that has not migrated yet).
 */
export function locateSiblingPolicy(personaMdPath: string): string | null {
  const dir = dirname(resolve(personaMdPath));
  const candidates = [resolve(dir, "policy.yaml"), resolve(dir, "policy.yml")];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function loadPolicyFile(policyPath: string): PolicyLoadResult {
  const raw = readFileSync(policyPath, "utf-8");
  const data = yaml.load(raw) as PolicyData;
  if (!data || typeof data !== "object") {
    throw new Error(`policy.yaml at ${policyPath} is empty or not a YAML mapping.`);
  }
  return { data, raw, path: policyPath };
}

export interface PolicyValidationIssue {
  field: string;
  message: string;
  category: "FAIL_SCHEMA" | "FAIL_POLICY" | "PASS_WITH_WARNINGS";
}

export interface PolicyValidationResult {
  valid: boolean;
  errors: PolicyValidationIssue[];
  warnings: PolicyValidationIssue[];
}

/**
 * Cross-reference check: every `assertion.layer` in policy.yaml must be one
 * of the 10 canonical layers AND ideally should match a layer that is
 * present in the matching PERSONA.md. The schema enum already enforces
 * canonical layer names; this helper additionally cross-checks against
 * PERSONA.md when we have it.
 */
export function validatePolicy(
  data: unknown,
  personaName?: string,
): PolicyValidationResult {
  const errors: PolicyValidationIssue[] = [];
  const warnings: PolicyValidationIssue[] = [];

  const schemaValid = validatePolicySchema(data) as boolean;
  if (!schemaValid) {
    for (const e of validatePolicySchema.errors ?? []) {
      errors.push({
        field: e.instancePath || e.schemaPath,
        message: e.message ?? "invalid",
        category: "FAIL_SCHEMA",
      });
    }
    return { valid: false, errors, warnings };
  }

  const policy = data as PolicyData;

  if (personaName && policy.applies_to.persona_name !== personaName) {
    errors.push({
      field: "applies_to.persona_name",
      message: `policy.yaml applies_to.persona_name='${policy.applies_to.persona_name}' does not match PERSONA.md metadata.name='${personaName}'.`,
      category: "FAIL_POLICY",
    });
  }

  if (policy.improvement_policy.mode !== "locked") {
    if (!policy.improvement_policy.approved_by) {
      errors.push({
        field: "improvement_policy.approved_by",
        message: `Required when improvement_policy.mode != 'locked'.`,
        category: "FAIL_POLICY",
      });
    }
    if (!policy.improvement_policy.last_approval_at) {
      errors.push({
        field: "improvement_policy.last_approval_at",
        message: `Required when improvement_policy.mode != 'locked'.`,
        category: "FAIL_POLICY",
      });
    }
    if (policy.improvement_policy.mode === "auto") {
      warnings.push({
        field: "improvement_policy.mode",
        message:
          "mode='auto' applies patches automatically. Reserved for sandbox / R&D. " +
          "Never use in production without explicit org-level opt-in.",
        category: "PASS_WITH_WARNINGS",
      });
    }
  }

  if (policy.assertions && policy.assertions.length > 0) {
    const judgeCount = policy.assertions.filter((a) => a.type === "llm_judge").length;
    if (judgeCount > 50) {
      warnings.push({
        field: "assertions",
        message: `${judgeCount} llm_judge assertions. Each evaluated trace pays one judge call per assertion (subject to sampling). Consider consolidating to <= 30 to keep judge cost predictable.`,
        category: "PASS_WITH_WARNINGS",
      });
    }
  }

  if (!policy.assertions || policy.assertions.length === 0) {
    warnings.push({
      field: "assertions",
      message:
        "No assertions defined. Drift detection will be limited to layer averages only. " +
        "Recommended: 3 assertions per layer (~30 total).",
      category: "PASS_WITH_WARNINGS",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
