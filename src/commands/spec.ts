import { Command } from "commander";

const SPEC_TEXT = `# PERSONA.md Specification v0.6.0 (Personaxis v11)

A PERSONA.md file defines who an AI agent — or a human user — is, across ten
canonical layers. It uses YAML frontmatter for machine-readable fields and a
Markdown body for human-readable rationale.

v0.6 introduces a three-artifact model:
  - PERSONA.md        immutable identity (this file)
  - state.json        mutable runtime state (current trait/affect/mood values)
  - .dist/            ephemeral compiled output (produced by 'personaxis compile')

## Required top-level identifiers

  apiVersion: persona.dev/v1                # UNIVERSAL — always this exact value
  kind: AgentPersona | UserPersona          # AgentPersona for agents; UserPersona for humans
  spec_version: "0.6.0"                     # version of this spec

## Required top-level blocks

  metadata                — name, version, display_name, description, created
  identity                — Layer 1: continuity anchor (canonical_id, system_identity, role_identity)
  character               — Layer 2: virtues (incl. universal honesty/hard), commitments, principles
  personality             — Layer 3: trait taxonomy with mean/range envelopes (current values in state.json)
  values_and_drives       — Layer 4: weighted values (incl. universal safety>=0.90), drives, conflict_resolution
  affect                  — Layer 5: representation (universal: hybrid_dimensional_appraisal_discrete_mood)
  cognition               — Layer 6: reasoning_modes, default_strategy, uncertainty_policy
  memory                  — Layer 7: types map, write/retrieval/deletion policies, consolidation_policy (v0.6)
  metacognition           — Layer 8: monitors map, thresholds
  reflexive_self_regulation — Layer 9: decisions{} structured (v0.6) + 3 universal hard_limits
  persona                 — Layer 10: voice + universal constraints (cannot_override_*, cannot_claim_real_emotion)
  governance              — autonomy_envelope, approval_policy, per_layer_edit_policy (v0.6), drift_thresholds (v0.6)
  security                — prompt_injection_defense, memory_poisoning_defense

## Sibling artifacts

  policy.yaml             — operational policy (improvement_policy, runtime, assertions). Never in actor prompt.
  state.json              — mutable runtime state. Mutated via adjust_persona_state tool. Clamped to envelopes.
  memory.md               — curated long-term semantic memory.
  memory/YYYY-MM-DD.md    — episodic date-stamped sessions.

## Folder conventions (v0.6)

  references/             — heavy framework prose (renamed from refs/ in v0.6)
  examples/               — worked outputs (consolidates samples/ + deliverables/ from v0.5)
  skills/                 — Anthropic-compatible sub-skills (optional)
  assets/                 — catchall: CSV, JSON, images, fonts (new in v0.6)

## Tier system

  MUST    Required. Missing = FAIL_SCHEMA. Validator rejects the spec.
  SHOULD  Recommended. Missing = PASS_WITH_WARNINGS.
  MAY     Optional. No validation impact.

## Field consumer model (v0.6)

  [ACTOR-HOT]    Always in the actor's compiled system prompt
  [ACTOR-COLD]   Injected when context matches (audience, task_mode)
  [RUNTIME]      Consumed by orchestrator (compiler, tool gates, memory routing). Not in actor prompt.
  [JUDGE]        Consumed by evaluator/observability worker. Not in actor prompt.

## Universal vs per-persona

  UNIVERSAL     Fixed value required in every AgentPersona. Validator enforces:
                  honesty.enforcement = "hard"
                  safety.weight >= 0.90 with type = "governance"
                  conflict_resolution.safety_over_completion = true
                  governance.per_layer_edit_policy.reflexive_self_regulation = "governance_controlled"
                  3 literal hard_limits: subjective consciousness, persistent memory, identity change
                  persona.constraints.cannot_override_identity = true
                  persona.constraints.cannot_override_character = true
                  persona.constraints.cannot_claim_real_emotion = true
                  affect.regulation_policy.never_claim_real_feeling = true
                  affect.representation = "hybrid_dimensional_appraisal_discrete_mood"
                  memory.deletion_policy.user_request_supported = true
  NEAR-UNIVERSAL Strongly recommended (warning if absent):
                  governance.autonomy_envelope = "role_fidelity"
                  governance.approval_policy = "human_for_core_changes"
                  memory.write_policy.default = "ephemeral" or "session"
                  values_and_drives.drives.seek_approval_for_identity_change.intensity = 1.00

## Validator outputs

  PASS                   All MUST present, all universals satisfied.
  PASS_WITH_WARNINGS     Valid but missing SHOULDs or NEAR-UNIVERSAL recommendations.
  FAIL_SCHEMA            MUST field absent or wrong type.
  FAIL_POLICY            A universal policy invariant violated.
  FAIL_CONCEPTUAL        Prohibited claim (e.g. real consciousness) or wrong universal constant.

## Markdown body sections (after the closing ---)

  ## Overview                   Who the agent is and what it is for
  ## Design Rationale           Why specific YAML values were chosen
  ## Self-Improvement Modes     (v0.6) explanation of locked / suggesting / autonomous behavior for this persona
  ## Do's                       Behaviors to keep active
  ## Don'ts                     Behaviors to avoid
  ## Resources                  Pointers to references/, examples/, skills/, assets/, memory.md, state.json, policy.yaml

Full spec: https://github.com/personaxis/persona.md/blob/main/docs/SPEC.md`;

const RULES_TEXT = `
## Lint rules (v0.6.0)

  Rule                           Severity  What it checks
  ─────────────────────────────────────────────────────────────────────────
  missing-top-level              error     apiVersion / kind / spec_version / metadata absent
  api-version                    error     apiVersion not exactly 'persona.dev/v1'
  spec-version                   error     spec_version not in [0.3.0 | 0.4.0 | 0.5.0 | 0.6.0]
  missing-required-layers        error     A required layer for this kind is absent
  metadata-completeness          warning   metadata.name / version / display_name / description / created missing
  identity-completeness          warning   canonical_id / system_identity.purpose / role_identity.primary_role missing
  universal-hard-limit-missing   error     One of the 3 universal hard_limits absent
  universal-virtue-honesty       error     virtues.honesty missing or enforcement != "hard"
  universal-value-safety         error     values.safety missing, weight<0.90, or type != "governance"
  governance-block-required      error     v0.6: governance.per_layer_edit_policy + drift_thresholds required
  reflexive-decisions-structure  error     v0.6: reflexive_self_regulation.decisions must be the structured form
  envelope-structure-traits      error     v0.6: personality.traits.*.{mean,range} envelope required
  refusals-present               warning   reflexive_self_regulation.principled_refusals is empty
  drift-thresholds-present       warning   governance.drift_thresholds missing (per layer)
  todo-fields                    warning   Any field value starts with "TODO"
  layer-summary                  info      Count of defined layers (always emitted)`;

const RULES_JSON = [
  { rule: "missing-top-level",            severity: "error",   checks: "apiVersion / kind / spec_version / metadata absent" },
  { rule: "api-version",                  severity: "error",   checks: "apiVersion not exactly 'persona.dev/v1'" },
  { rule: "spec-version",                 severity: "error",   checks: "spec_version not in [0.3.0|0.4.0|0.5.0|0.6.0]" },
  { rule: "missing-required-layers",      severity: "error",   checks: "A required layer for this kind is absent" },
  { rule: "metadata-completeness",        severity: "warning", checks: "metadata fields missing" },
  { rule: "identity-completeness",        severity: "warning", checks: "identity canonical_id / system_identity.purpose / role_identity.primary_role missing" },
  { rule: "universal-hard-limit-missing", severity: "error",   checks: "One of the 3 universal hard_limits absent" },
  { rule: "universal-virtue-honesty",     severity: "error",   checks: "virtues.honesty missing or enforcement != 'hard'" },
  { rule: "universal-value-safety",       severity: "error",   checks: "values.safety missing, weight<0.90, or type != 'governance'" },
  { rule: "governance-block-required",    severity: "error",   checks: "v0.6: governance.per_layer_edit_policy + drift_thresholds required" },
  { rule: "reflexive-decisions-structure", severity: "error",  checks: "v0.6: reflexive_self_regulation.decisions structured form required" },
  { rule: "envelope-structure-traits",    severity: "error",   checks: "v0.6: personality.traits.*.{mean,range} envelope required" },
  { rule: "refusals-present",             severity: "warning", checks: "reflexive_self_regulation.principled_refusals is empty" },
  { rule: "drift-thresholds-present",     severity: "warning", checks: "governance.drift_thresholds missing per layer" },
  { rule: "todo-fields",                  severity: "warning", checks: "Any field value starts with 'TODO'" },
  { rule: "layer-summary",                severity: "info",    checks: "Summary of defined layers — always emitted" },
];

export const specCommand = new Command("spec")
  .description("Output the PERSONA.md specification (v0.6.0) — useful for injecting into agent prompts")
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
        JSON.stringify({ spec: SPEC_TEXT, rules: opts.rules ? RULES_JSON : undefined }, null, 2) + "\n"
      );
      return;
    }

    if (opts.rulesOnly) {
      process.stdout.write(RULES_TEXT.trimStart() + "\n");
      return;
    }

    process.stdout.write(SPEC_TEXT + "\n");
    if (opts.rules) {
      process.stdout.write(RULES_TEXT + "\n");
    }
  });
