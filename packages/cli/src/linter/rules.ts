import { extractEnvelopes, staticallyDecorative, type PersonaFrontmatter } from "@personaxis/core";
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

  // v1.0 vs legacy (≤0.10) dispatch — the linter mirrors the validator's version awareness.
  const isV1 = String(data.spec_version ?? "").startsWith("1.") || data.apiVersion === "personaxis.com/v1";
  const expectedApi = isV1 ? "personaxis.com/v1" : "persona.dev/v1";
  const layer9 = isV1 ? "self_regulation" : "reflexive_self_regulation";
  const requiredLayers = REQUIRED_LAYERS.map((l) => (l === "reflexive_self_regulation" ? layer9 : l));

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

  if (data.apiVersion && data.apiVersion !== expectedApi) {
    findings.push({
      rule: "api-version",
      severity: "error",
      path: "apiVersion",
      message: `apiVersion must be exactly '${expectedApi}'.`,
    });
  }

  const SUPPORTED_SPEC_VERSIONS = new Set(["0.3.0", "0.4.0", "0.5.0", "0.6.0", "0.7.0", "0.8.0", "0.9.0", "0.10.0", "1.0.0", "1.1.0"]);
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
    // v1.0 dropped metadata.display_name (single owner: identity.display_name).
    const metaFields: string[] = isV1
      ? ["name", "version", "description", "created"]
      : ["name", "version", "display_name", "description", "created"];
    for (const field of metaFields) {
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
  const layersToCheck = isAgent ? requiredLayers : userPersonaRequired;

  for (const layer of requiredLayers) {
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

  // v1.1 arbitration coherence (SPEC §15 / MATH_CORE A2): a non-safety value that
  // is governance-typed with weight ≥ safety's would outrank safety in arbitration —
  // legal, but almost always an authoring mistake worth flagging.
  const vad = asObj(data.values_and_drives);
  const vals = asObj(vad?.values);
  if (vals) {
    const safety = asObj(vals.safety);
    const safetyWeight = typeof safety?.weight === "number" ? safety.weight : undefined;
    if (safetyWeight !== undefined) {
      for (const [name, raw] of Object.entries(vals)) {
        if (name === "safety") continue;
        const v = asObj(raw);
        if (v?.type === "governance" && typeof v.weight === "number" && v.weight >= safetyWeight) {
          findings.push({
            rule: "arbitration-governance-outranks-safety",
            severity: "warning",
            path: `values_and_drives.values.${name}`,
            message: `'${name}' is type: governance with weight ${v.weight} ≥ safety's ${safetyWeight} — it would outrank safety in arbitration (SPEC §15). Lower its weight or drop the governance type unless this is deliberate.`,
          });
        }
      }
    }
  }

  // F6.4 decorative numbers (MATH_CORE Def. 10 / audit F-21): a mutable coordinate
  // whose value PROVABLY cannot change the compiled artifact — no expression, a
  // band-independent string, or identical prose across its reachable bands.
  // σ_compile = 0 exactly; `personaxis jacobian` shows the full ranking.
  try {
    const lookup = extractEnvelopes(data as PersonaFrontmatter);
    for (const [field, e] of Object.entries(lookup.envelopes)) {
      if (staticallyDecorative(e)) {
        findings.push({
          rule: "decorative-number",
          severity: "warning",
          path: field,
          message: `'${field}' declares an envelope but no per-band expression — its value cannot change the compiled artifact (σ=0). Add expression {low, moderate, high} to make the number load-bearing (SPEC §L3).`,
        });
      }
      // PA-7 (FASE 7 foundations review): bandBoundaries silently falls back to
      // the defaults when a declared pair is unusable (low_max >= moderate_max).
      // Silence hides authoring mistakes; say it.
      if (
        e.bands &&
        typeof e.bands.low_max === "number" &&
        typeof e.bands.moderate_max === "number" &&
        e.bands.low_max >= e.bands.moderate_max
      ) {
        findings.push({
          rule: "bands-unusable",
          severity: "warning",
          path: field,
          message: `'${field}' declares bands with low_max (${e.bands.low_max}) >= moderate_max (${e.bands.moderate_max}); the runtime ignores the pair and falls back to the defaults. Fix the boundaries so low_max < moderate_max.`,
        });
      }
    }
  } catch {
    // envelope extraction must never crash the linter on malformed frontmatter
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

  // self_regulation (v1.0) / reflexive_self_regulation (legacy) — universal hard_limits + refusals
  if (isAgent) {
    const reflexive = asObj(data[layer9]);
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
            path: `${layer9}.hard_limits`,
            message: `Universal hard_limit missing: "${u}"`,
          });
        }
      }
      // v1.0 folded principled_refusals into character.prohibited_behaviors; legacy keeps it under layer 9.
      const refusals = isV1
        ? asObj(data.character)?.prohibited_behaviors
        : reflexive.principled_refusals;
      if (!refusals || !Array.isArray(refusals) || refusals.length === 0) {
        findings.push({
          rule: "refusals-present",
          severity: "warning",
          path: isV1 ? "character.prohibited_behaviors" : "reflexive_self_regulation.principled_refusals",
          message:
            "No explicit refusals declared. Without them, the agent has no defined limits under situational pressure.",
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
        "self_regulation",
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

  // Runtime honesty (G3): some declared memory facets are not yet enforced by the
  // reference runtime. Warn so the spec never silently over-promises behavior.
  const mem = asObj(data.memory);
  const memTypes = mem ? asObj(mem.types) : undefined;
  // All six memory.types are now enforced by the runtime (episodic, semantic, procedural,
  // autobiographical, user_preferences, evaluations) — no honesty warning needed here.
  void memTypes;
  for (const policy of ["consolidation_policy", "retrieval_policy", "write_policy"]) {
    if (mem && mem[policy] !== undefined) {
      findings.push({
        rule: "memory-policy-unenforced",
        severity: "warning",
        path: `memory.${policy}`,
        message: `'memory.${policy}' is declared but NOT yet consumed by this runtime.`,
      });
    }
  }

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

  // Persona-prompting source material (MAY) — honest, tier-aware checks.
  // v1.0: lives inside layer 10 `persona`; ≤0.10: the top-level persona_prompting block.
  const personaLayer = asObj(data.persona);
  const v1pp =
    personaLayer && (personaLayer.address ?? personaLayer.voice_exemplars ?? personaLayer.scene_contracts)
      ? personaLayer
      : undefined;
  const ppBase = v1pp ? "persona" : "persona_prompting";
  const pp = asObj(data.persona_prompting) ?? v1pp;
  if (pp) {
    const addr = asObj(pp.address);
    if (addr && (typeof addr.you_are !== "string" || !addr.you_are.trim())) {
      findings.push({
        rule: "persona-prompting-address",
        severity: "warning",
        path: `${ppBase}.address.you_are`,
        message: "the persona-prompting address is set but 'you_are' is empty — role adoption is the strongest device; provide a one-line 'You are <name>…'.",
      });
    }
    const exemplars = Array.isArray(pp.voice_exemplars) ? pp.voice_exemplars.length : 0;
    if (exemplars > 0 && exemplars < 2) {
      findings.push({
        rule: "persona-prompting-voice",
        severity: "info",
        path: `${ppBase}.voice_exemplars`,
        message: "Only one voice exemplar — 2-4 few-shot samples anchor the register more reliably.",
      });
    }
    if (Array.isArray(pp.break_character_guardrails) && pp.break_character_guardrails.length > 0) {
      findings.push({
        rule: "persona-prompting-guardrails",
        severity: "info",
        path: `${ppBase}.break_character_guardrails`,
        message: "Break-character guardrails present — note they NEVER override the safety universals (the compiler enforces this ordering).",
      });
    }
  } else if (isAgent) {
    findings.push({
      rule: "persona-prompting-absent",
      severity: "info",
      path: "persona",
      message: "No persona-prompting source material (v1.0: persona.address/voice_exemplars/scene_contracts; ≤0.10: the persona_prompting block) — the compiled PERSONA.md will be derived from the quantitative layers. Adding voice_exemplars/scene_contracts/anchors yields a richer, more in-character document (see docs/PERSONA_PROMPTING.md).",
    });
  }

  return { findings, presentLayers, missingLayers };
}
