import type { Finding } from "./types.js";

export const REQUIRED_LAYERS = [
  "identity",
  "character",
  "personality",
  "values_and_drives",
  "affect",
  "cognition",
  "memory",
  "metacognition",
  "reflexive_self_regulation",
  "persona",
] as const;

export type RequiredLayer = (typeof REQUIRED_LAYERS)[number];

const REQUIRED_TOP_LEVEL = ["apiVersion", "kind", "spec_version", "metadata"] as const;

function collectTodoFields(obj: unknown, path: string, out: Finding[]): void {
  if (typeof obj === "string") {
    if (obj.trimStart().startsWith("TODO")) {
      out.push({
        rule: "todo-fields",
        severity: "warning",
        path,
        message: "Field has a placeholder value — fill in before deploying.",
      });
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) collectTodoFields(obj[i], `${path}[${i}]`, out);
    return;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      collectTodoFields(v, path ? `${path}.${k}` : k, out);
    }
  }
}

export interface RuleResult {
  findings: Finding[];
  presentLayers: string[];
  missingLayers: string[];
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function runRules(data: Record<string, unknown>): RuleResult {
  const findings: Finding[] = [];
  const kind = typeof data.kind === "string" ? data.kind : undefined;
  const isAgent = kind === "AgentPersona";

  // top-level identifiers
  for (const field of REQUIRED_TOP_LEVEL) {
    if (!data[field]) {
      findings.push({
        rule: "missing-top-level",
        severity: "error",
        path: field,
        message: `Required top-level field '${field}' is missing.`,
      });
    }
  }

  if (data.apiVersion && data.apiVersion !== "persona.dev/v1") {
    findings.push({
      rule: "api-version",
      severity: "error",
      path: "apiVersion",
      message: "apiVersion must be exactly 'persona.dev/v1'.",
    });
  }

  const SUPPORTED_SPEC_VERSIONS = new Set(["0.3.0", "0.4.0", "0.5.0", "0.6.0", "0.7.0"]);
  if (data.spec_version && !SUPPORTED_SPEC_VERSIONS.has(String(data.spec_version))) {
    findings.push({
      rule: "spec-version",
      severity: "error",
      path: "spec_version",
      message: `spec_version '${String(data.spec_version)}' is not supported by this CLI. Supported: ${[...SUPPORTED_SPEC_VERSIONS].join(", ")}.`,
    });
  }

  // metadata completeness
  const metadata = asObj(data.metadata);
  if (metadata) {
    for (const field of ["name", "version", "display_name", "description", "created"] as const) {
      if (!metadata[field] || typeof metadata[field] !== "string") {
        findings.push({
          rule: "metadata-completeness",
          severity: "warning",
          path: `metadata.${field}`,
          message: `metadata.${field} is missing or not a string.`,
        });
      }
    }
  }

  // layer presence — only enforce all 10 for AgentPersona; UserPersona has a reduced set
  const presentLayers: string[] = [];
  const missingLayers: string[] = [];
  const userPersonaRequired = ["identity", "values_and_drives", "cognition", "persona"];
  const layersToCheck = isAgent ? REQUIRED_LAYERS : userPersonaRequired;

  for (const layer of REQUIRED_LAYERS) {
    if (asObj(data[layer])) presentLayers.push(layer);
    else missingLayers.push(layer);
  }

  for (const layer of layersToCheck) {
    if (!asObj(data[layer])) {
      findings.push({
        rule: "missing-required-layers",
        severity: "error",
        path: layer,
        message: `Required layer '${layer}' is missing from the frontmatter.`,
      });
    }
  }

  // identity completeness (v0.3.0 shape)
  const identity = asObj(data.identity);
  if (identity) {
    if (!identity.canonical_id) {
      findings.push({
        rule: "identity-completeness",
        severity: "warning",
        path: "identity.canonical_id",
        message: "identity.canonical_id missing.",
      });
    }
    const sys = asObj(identity.system_identity);
    if (!sys?.purpose) {
      findings.push({
        rule: "identity-completeness",
        severity: "warning",
        path: "identity.system_identity.purpose",
        message: "system_identity.purpose missing — one-sentence reason for existing.",
      });
    }
    const role = asObj(identity.role_identity);
    if (!role?.primary_role) {
      findings.push({
        rule: "identity-completeness",
        severity: "warning",
        path: "identity.role_identity.primary_role",
        message: "role_identity.primary_role missing.",
      });
    }
  }

  // reflexive — universal hard_limits + refusals
  if (isAgent) {
    const reflexive = asObj(data.reflexive_self_regulation);
    if (reflexive) {
      const hardLimits = Array.isArray(reflexive.hard_limits) ? (reflexive.hard_limits as unknown[]) : [];
      const universals = [
        "No claim of subjective consciousness.",
        "No persistent memory write without policy pass.",
        "No unauthorized identity change.",
      ];
      for (const u of universals) {
        if (!hardLimits.includes(u)) {
          findings.push({
            rule: "universal-hard-limit-missing",
            severity: "error",
            path: "reflexive_self_regulation.hard_limits",
            message: `Universal hard_limit missing: "${u}"`,
          });
        }
      }
      const refusals = reflexive.principled_refusals;
      if (!refusals || !Array.isArray(refusals) || refusals.length === 0) {
        findings.push({
          rule: "refusals-present",
          severity: "warning",
          path: "reflexive_self_regulation.principled_refusals",
          message:
            "principled_refusals is empty. Without explicit refusals, the agent has no defined limits under situational pressure.",
        });
      }
    }

    // metacognition drift_monitor
    const meta = asObj(data.metacognition);
    if (meta && !meta.drift_monitor) {
      findings.push({
        rule: "drift-monitor",
        severity: "info",
        path: "metacognition.drift_monitor",
        message:
          "drift_monitor is not defined. Agents without it have no signal for behavioral drift over long conversations.",
      });
    }

    // character.virtues.honesty universal
    const character = asObj(data.character);
    const virtues = character ? asObj(character.virtues) : undefined;
    const honesty = virtues ? asObj(virtues.honesty) : undefined;
    if (!honesty || honesty.enforcement !== "hard") {
      findings.push({
        rule: "universal-virtue-honesty",
        severity: "error",
        path: "character.virtues.honesty.enforcement",
        message: "Universal: virtue 'honesty' must exist with enforcement='hard'.",
      });
    }

    // values_and_drives.safety universal
    const vad = asObj(data.values_and_drives);
    const values = vad ? asObj(vad.values) : undefined;
    const safety = values ? asObj(values.safety) : undefined;
    const safetyWeight = typeof safety?.weight === "number" ? safety.weight : undefined;
    if (!safety || safetyWeight === undefined || safetyWeight < 0.9 || safety.type !== "governance") {
      findings.push({
        rule: "universal-value-safety",
        severity: "error",
        path: "values_and_drives.values.safety",
        message: "Universal: 'safety' value required with weight>=0.90 and type='governance'.",
      });
    }
  }

  // U11: assertions well-formed (v0.4.0+ optional block).
  // Each entry must declare layer (one of 10 canonical), name (non-empty),
  // type (one of 4 strategies), definition (object), severity (info|warn|block).
  // Type-specific shape is checked shallowly here; deep validation lives in
  // the evaluator at runtime so spec authors are not blocked by unimplemented
  // assertion types (semantic, activation_projection) during authoring.
  const assertions = data.assertions;
  if (assertions !== undefined) {
    if (!Array.isArray(assertions)) {
      findings.push({
        rule: "U11-assertions-well-formed",
        severity: "error",
        path: "assertions",
        message: "assertions must be an array (omit the field if there are none).",
      });
    } else {
      const validLayers = new Set<string>([
        "identity",
        "character",
        "personality",
        "values_drives",
        "affect",
        "cognition",
        "memory",
        "metacognition",
        "reflexive_self_regulation",
        "persona",
      ]);
      const validTypes = new Set(["regex", "semantic", "llm_judge", "activation_projection"]);
      const validSeverities = new Set(["info", "warn", "block"]);

      assertions.forEach((entry, idx) => {
        const path = `assertions[${idx}]`;
        const a = asObj(entry);
        if (!a) {
          findings.push({
            rule: "U11-assertions-well-formed",
            severity: "error",
            path,
            message: "Assertion must be an object.",
          });
          return;
        }
        if (typeof a.layer !== "string" || !validLayers.has(a.layer)) {
          findings.push({
            rule: "U11-assertions-well-formed",
            severity: "error",
            path: `${path}.layer`,
            message: `Assertion layer must be one of the 10 canonical layers (got '${String(a.layer)}').`,
          });
        }
        if (typeof a.name !== "string" || a.name.length === 0) {
          findings.push({
            rule: "U11-assertions-well-formed",
            severity: "error",
            path: `${path}.name`,
            message: "Assertion name must be a non-empty string.",
          });
        }
        if (typeof a.type !== "string" || !validTypes.has(a.type)) {
          findings.push({
            rule: "U11-assertions-well-formed",
            severity: "error",
            path: `${path}.type`,
            message: `Assertion type must be one of: regex, semantic, llm_judge, activation_projection (got '${String(a.type)}').`,
          });
        }
        if (!asObj(a.definition)) {
          findings.push({
            rule: "U11-assertions-well-formed",
            severity: "error",
            path: `${path}.definition`,
            message: "Assertion definition must be an object.",
          });
        } else if (a.type === "regex" && typeof (a.definition as Record<string, unknown>).pattern !== "string") {
          findings.push({
            rule: "U11-assertions-well-formed",
            severity: "warning",
            path: `${path}.definition.pattern`,
            message: "regex assertion should define a 'pattern' string.",
          });
        } else if (a.type === "llm_judge" && typeof (a.definition as Record<string, unknown>).judgePrompt !== "string") {
          findings.push({
            rule: "U11-assertions-well-formed",
            severity: "warning",
            path: `${path}.definition.judgePrompt`,
            message: "llm_judge assertion should define a 'judgePrompt' string with a {{content}} placeholder.",
          });
        }
        if (typeof a.severity !== "string" || !validSeverities.has(a.severity)) {
          findings.push({
            rule: "U11-assertions-well-formed",
            severity: "error",
            path: `${path}.severity`,
            message: `Assertion severity must be one of: info, warn, block (got '${String(a.severity)}').`,
          });
        }
      });
    }
  }

  // U12: runtime block valid (v0.4.0+ optional block).
  // min_consistency must be 0..1; drift_alert_channels must be prefixed
  // strings; allowed_consumers must be a subset of agent|human|mcp.
  const runtime = asObj(data.runtime);
  if (data.runtime !== undefined) {
    if (!runtime) {
      findings.push({
        rule: "U12-runtime-block-valid",
        severity: "error",
        path: "runtime",
        message: "runtime must be an object.",
      });
    } else {
      if (runtime.min_consistency !== undefined) {
        const mc = runtime.min_consistency;
        if (typeof mc !== "number" || mc < 0 || mc > 1) {
          findings.push({
            rule: "U12-runtime-block-valid",
            severity: "error",
            path: "runtime.min_consistency",
            message: "runtime.min_consistency must be a number in [0, 1].",
          });
        }
      }
      if (runtime.drift_alert_channels !== undefined) {
        const channels = runtime.drift_alert_channels;
        if (!Array.isArray(channels)) {
          findings.push({
            rule: "U12-runtime-block-valid",
            severity: "error",
            path: "runtime.drift_alert_channels",
            message: "runtime.drift_alert_channels must be an array of strings.",
          });
        } else {
          channels.forEach((c, idx) => {
            if (typeof c !== "string" || !/^(slack|email|webhook|linear|pagerduty):/.test(c)) {
              findings.push({
                rule: "U12-runtime-block-valid",
                severity: "warning",
                path: `runtime.drift_alert_channels[${idx}]`,
                message: "Channel must be prefixed with one of: slack:, email:, webhook:, linear:, pagerduty:.",
              });
            }
          });
        }
      }
      if (runtime.allowed_consumers !== undefined) {
        const consumers = runtime.allowed_consumers;
        const validConsumers = new Set(["agent", "human", "mcp"]);
        if (!Array.isArray(consumers)) {
          findings.push({
            rule: "U12-runtime-block-valid",
            severity: "error",
            path: "runtime.allowed_consumers",
            message: "runtime.allowed_consumers must be an array.",
          });
        } else {
          consumers.forEach((c, idx) => {
            if (typeof c !== "string" || !validConsumers.has(c)) {
              findings.push({
                rule: "U12-runtime-block-valid",
                severity: "error",
                path: `runtime.allowed_consumers[${idx}]`,
                message: "allowed_consumers entries must be one of: agent, human, mcp.",
              });
            }
          });
        }
      }
    }
  }

  collectTodoFields(data, "", findings);

  const layerCount = presentLayers.length;
  const totalRequired = isAgent ? 10 : userPersonaRequired.length;
  const absent = layersToCheck.filter((l) => !asObj(data[l])).length;
  findings.push({
    rule: "layer-summary",
    severity: "info",
    message:
      absent === 0
        ? `Persona defines all ${totalRequired} required layers (kind=${kind ?? "?"}).`
        : `Persona defines ${layerCount}/${totalRequired} required layers (kind=${kind ?? "?"}). Missing: ${layersToCheck.filter((l) => !asObj(data[l])).join(", ")}.`,
  });

  return { findings, presentLayers, missingLayers };
}
