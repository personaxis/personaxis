import { Command } from "commander";
import { specDoc } from "../generated/assets.js";

// The spec document itself is the embedded, byte-identical copy of persona.md/docs/SPEC.md (current,
// v0.10) — regenerated from the single source on every build, so `personaxis spec` can never go stale.
// Below are the CLI's own lint rules (mirroring src/linter/rules.ts), which are separate from the spec.

const RULES_TEXT = `
## Lint rules

  Rule                           Severity  What it checks
  ─────────────────────────────────────────────────────────────────────────
  missing-top-level              error     apiVersion / kind / spec_version / metadata absent
  api-version                    error     apiVersion not exactly 'persona.dev/v1'
  spec-version                   error     spec_version not in [0.3.0 … 0.10.0]
  missing-required-layers        error     A required layer for this kind is absent
  metadata-completeness          warning   metadata.name / version / display_name / description / created missing
  identity-completeness          warning   canonical_id / system_identity.purpose / role_identity.primary_role missing
  universal-hard-limit-missing   error     One of the 3 universal hard_limits absent
  universal-virtue-honesty       error     virtues.honesty missing or enforcement != "hard"
  universal-value-safety         error     values.safety missing, weight<0.90, or type != "governance"
  governance-block-required      error     governance.per_layer_edit_policy + drift_thresholds required
  reflexive-decisions-structure  error     reflexive_self_regulation.decisions must be the structured form
  envelope-structure-traits      error     personality.traits.*.{mean,range} envelope required
  refusals-present               warning   reflexive_self_regulation.principled_refusals is empty
  drift-thresholds-present       warning   governance.drift_thresholds missing (per layer)
  todo-fields                    warning   Any field value starts with "TODO"
  layer-summary                  info      Count of defined layers (always emitted)`;

const RULES_JSON = [
  { rule: "missing-top-level",            severity: "error",   checks: "apiVersion / kind / spec_version / metadata absent" },
  { rule: "api-version",                  severity: "error",   checks: "apiVersion not exactly 'persona.dev/v1'" },
  { rule: "spec-version",                 severity: "error",   checks: "spec_version not in [0.3.0…0.10.0]" },
  { rule: "missing-required-layers",      severity: "error",   checks: "A required layer for this kind is absent" },
  { rule: "metadata-completeness",        severity: "warning", checks: "metadata fields missing" },
  { rule: "identity-completeness",        severity: "warning", checks: "identity canonical_id / system_identity.purpose / role_identity.primary_role missing" },
  { rule: "universal-hard-limit-missing", severity: "error",   checks: "One of the 3 universal hard_limits absent" },
  { rule: "universal-virtue-honesty",     severity: "error",   checks: "virtues.honesty missing or enforcement != 'hard'" },
  { rule: "universal-value-safety",       severity: "error",   checks: "values.safety missing, weight<0.90, or type != 'governance'" },
  { rule: "governance-block-required",    severity: "error",   checks: "governance.per_layer_edit_policy + drift_thresholds required" },
  { rule: "reflexive-decisions-structure", severity: "error",  checks: "reflexive_self_regulation.decisions structured form required" },
  { rule: "envelope-structure-traits",    severity: "error",   checks: "personality.traits.*.{mean,range} envelope required" },
  { rule: "refusals-present",             severity: "warning", checks: "reflexive_self_regulation.principled_refusals is empty" },
  { rule: "drift-thresholds-present",     severity: "warning", checks: "governance.drift_thresholds missing per layer" },
  { rule: "todo-fields",                  severity: "warning", checks: "Any field value starts with 'TODO'" },
  { rule: "layer-summary",                severity: "info",    checks: "Summary of defined layers — always emitted" },
];

export const specCommand = new Command("spec")
  .description("Print the current personaxis.md spec (v0.10, from persona.md/docs/SPEC.md) + lint rules — inject into agent prompts")
  .option("--rules", "Append the lint rules table")
  .option("--rules-only", "Output only the lint rules")
  .option("--format <format>", "Output format: text (default) or json", "text")
  .action((opts: { rules?: boolean; rulesOnly?: boolean; format: string }) => {
    if (opts.format === "json") {
      if (opts.rulesOnly) {
        process.stdout.write(JSON.stringify(RULES_JSON, null, 2) + "\n");
        return;
      }
      process.stdout.write(
        JSON.stringify({ spec: specDoc, rules: opts.rules ? RULES_JSON : undefined }, null, 2) + "\n",
      );
      return;
    }

    if (opts.rulesOnly) {
      process.stdout.write(RULES_TEXT.trimStart() + "\n");
      return;
    }

    process.stdout.write(specDoc.trimEnd() + "\n");
    if (opts.rules) {
      process.stdout.write(RULES_TEXT + "\n");
    }
  });
