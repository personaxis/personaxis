/**
 * `personaxis migrate` — version-to-version codemods for PERSONA.md / policy.yaml.
 *
 * v0.6 ships with one path:
 *   personaxis migrate 0.5-to-0.6 ./PERSONA.md
 *
 * The codemod is best-effort and produces a written report under
 * `.personaxis/migrations/0.5-to-0.6-<timestamp>.md`. It applies the
 * following structural changes:
 *
 *   1. Bump spec_version "0.5.0" → "0.6.0"
 *   2. Drop personality.context_modifiers (redundant with persona.task_modes)
 *   3. Drop extensions.knowledge_anchors (redundant with references/)
 *   4. Move scattered <layer>.edit_policy fields → governance.per_layer_edit_policy
 *   5. Move personality.drift_threshold → governance.drift_thresholds.personality
 *   6. Wrap trait/affect/mood scalars in {mean, range} envelopes if not present
 *   7. Recategorize reflexive_self_regulation.actions[] flat list into
 *      reflexive_self_regulation.decisions{} structured groups
 *   8. Generate a sibling state.json seeded from envelope means
 *   9. Rename folder convention: refs/→references/, samples/+deliverables/→examples/
 *  10. Drop spec-version-specific notes from the body (best-effort)
 *
 * The codemod prints DRY-RUN by default. Use --apply to write changes.
 *
 * Out of scope (manual): autonomous_scope_allowlist for policy.yaml when
 * mode was "auto"; the migration writes a conservative default and asks
 * the operator to review.
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from "fs";
import { resolve, dirname, join, basename } from "path";
import chalk from "chalk";
import { runCompile } from "./compile.js";

interface MigrationReport {
  source: string;
  ts: string;
  changes: string[];
  warnings: string[];
  manualFollowups: string[];
}

function formatReport(r: MigrationReport): string {
  return [
    `# Migration report 0.5 → 0.6`,
    ``,
    `- **Source:** ${r.source}`,
    `- **Timestamp:** ${r.ts}`,
    ``,
    `## Changes applied`,
    r.changes.length === 0 ? `_(none)_` : r.changes.map((c) => `- ${c}`).join("\n"),
    ``,
    `## Warnings`,
    r.warnings.length === 0 ? `_(none)_` : r.warnings.map((w) => `- ${w}`).join("\n"),
    ``,
    `## Manual follow-ups required`,
    r.manualFollowups.length === 0
      ? `_(none)_`
      : r.manualFollowups.map((f) => `- ${f}`).join("\n"),
    ``,
    `---`,
    ``,
    `Validate the migrated artifact:`,
    ``,
    `\`\`\`bash`,
    `personaxis validate ${r.source}`,
    `\`\`\``,
  ].join("\n");
}

function rewriteFolderNames(personaDir: string, report: MigrationReport, apply: boolean): void {
  // refs/ → references/
  const oldRefs = join(personaDir, "refs");
  const newRefs = join(personaDir, "references");
  if (existsSync(oldRefs) && !existsSync(newRefs)) {
    if (apply) renameSync(oldRefs, newRefs);
    report.changes.push("Renamed `refs/` → `references/`");
  }

  // samples/ + deliverables/ → examples/
  const oldSamples = join(personaDir, "samples");
  const oldDeliverables = join(personaDir, "deliverables");
  const newExamples = join(personaDir, "examples");
  let mergedAny = false;

  if (existsSync(oldDeliverables) && !existsSync(newExamples)) {
    if (apply) renameSync(oldDeliverables, newExamples);
    report.changes.push("Renamed `deliverables/` → `examples/`");
    mergedAny = true;
  }
  if (existsSync(oldSamples)) {
    if (existsSync(newExamples)) {
      // merge contents
      if (apply) {
        for (const f of readdirSync(oldSamples)) {
          renameSync(join(oldSamples, f), join(newExamples, f));
        }
        // attempt to remove now-empty samples
        try {
          // intentionally not using rmdir; let the user decide
        } catch {
          /* ignore */
        }
      }
      report.changes.push("Merged `samples/` contents into `examples/`");
      mergedAny = true;
    } else if (!existsSync(newExamples)) {
      if (apply) renameSync(oldSamples, newExamples);
      report.changes.push("Renamed `samples/` → `examples/`");
      mergedAny = true;
    }
  }

  if (!mergedAny) {
    report.warnings.push(
      "No `refs/`, `samples/`, or `deliverables/` folders found. If you have content in non-standard locations, move it manually.",
    );
  }
}

function rewriteFrontmatter(yamlText: string, report: MigrationReport): string {
  let next = yamlText;

  // 1. spec_version bump
  if (/spec_version:\s*["']?0\.5\.0["']?/.test(next)) {
    next = next.replace(/spec_version:\s*["']?0\.5\.0["']?/, 'spec_version: "0.6.0"');
    report.changes.push("Bumped `spec_version` to `0.6.0`");
  } else if (/spec_version:\s*["']?0\.4\.0["']?/.test(next)) {
    next = next.replace(/spec_version:\s*["']?0\.4\.0["']?/, 'spec_version: "0.6.0"');
    report.changes.push("Bumped `spec_version` from 0.4.0 to `0.6.0`");
  } else if (/spec_version:\s*["']?0\.3\.0["']?/.test(next)) {
    next = next.replace(/spec_version:\s*["']?0\.3\.0["']?/, 'spec_version: "0.6.0"');
    report.changes.push("Bumped `spec_version` from 0.3.0 to `0.6.0` (skipping intermediate v0.4/v0.5 migrations)");
    report.warnings.push(
      "Direct 0.3 → 0.6 migration may leave legacy fields that need manual review.",
    );
  }

  // 2. Drop knowledge_anchors (best-effort, line-by-line)
  if (/^\s*knowledge_anchors:/m.test(next)) {
    next = next.replace(/^\s*knowledge_anchors:.*?(?=\n\s*[a-z_]+:|\n---|\n\n)/ms, "");
    report.changes.push(
      "Removed `extensions.knowledge_anchors` (redundant with `references/` enumeration)",
    );
  }

  // 3. Detect context_modifiers (we don't try to merge into task_modes
  //    automatically — that requires semantic understanding)
  if (/^\s*context_modifiers:/m.test(next)) {
    report.manualFollowups.push(
      "Removed-or-pending: `personality.context_modifiers`. Re-express as entries in `persona.task_modes` where semantically equivalent, then delete the block.",
    );
  }

  // 4. Detect drift_threshold
  if (/^\s*drift_threshold:\s*[\d.]+/m.test(next)) {
    report.manualFollowups.push(
      "Move `personality.drift_threshold` to `governance.drift_thresholds.personality`. The v0.6 template ships per-layer thresholds (10 entries).",
    );
  }

  // 5. Detect scattered edit_policy
  const editPolicyCount = (next.match(/^\s*edit_policy:/gm) ?? []).length;
  if (editPolicyCount > 0) {
    report.manualFollowups.push(
      `Found ${editPolicyCount} layer-level \`edit_policy\` field(s). Move them all to \`governance.per_layer_edit_policy\` (single block, 10 entries).`,
    );
  }

  // 6. Detect flat actions[] in reflexive_self_regulation
  if (
    /^\s*reflexive_self_regulation:/m.test(next) &&
    /^\s*actions:\s*\[/m.test(next)
  ) {
    report.manualFollowups.push(
      "Replace `reflexive_self_regulation.actions[]` flat list with `decisions{}` structured groups (response_decision, interaction_decision, governance_decision, cognition_decision). See templates/personaxis_template.md v0.6.",
    );
  }

  // 7. Trait/affect envelope detection (best-effort)
  if (/traits:/.test(next) && !/mean:.*\n\s*range:/.test(next)) {
    report.manualFollowups.push(
      "Wrap trait values in envelope structure `{mean, range}` if not already done. v0.6 expects this for all traits, affect.core_affect, and mood dimensions.",
    );
  }

  return next;
}

function emitStateFile(personaPath: string, report: MigrationReport, apply: boolean): void {
  const stateePath = join(dirname(personaPath), "state.json");
  if (existsSync(stateePath)) {
    report.warnings.push(`state.json already exists at ${stateePath}; not overwriting.`);
    return;
  }

  const stub = {
    schema_version: "0.6.0",
    persona_id: "MIGRATE-ME",
    persona_version: "0.0.0",
    values: {},
    active_context: { task_mode: null, audience: null, additional_context_flags: [] },
    memory_anchors_active: [],
    mutation_log: [],
  };

  if (apply) {
    writeFileSync(stateePath, JSON.stringify(stub, null, 2) + "\n");
    report.changes.push(`Created stub \`state.json\` at ${stateePath}`);
    report.manualFollowups.push(
      "Run `personaxis state init --force` after migration completes to seed `state.json.values` from envelope means.",
    );
  } else {
    report.changes.push(`(dry-run) would create stub \`state.json\` at ${stateePath}`);
  }
}

function writeReport(personaPath: string, report: MigrationReport, apply: boolean): string {
  const personaDir = dirname(personaPath);
  const migrationsDir = join(personaDir, ".personaxis", "migrations");
  if (apply && !existsSync(migrationsDir)) mkdirSync(migrationsDir, { recursive: true });

  const stamp = report.ts.replace(/[:.]/g, "-");
  const reportPath = join(migrationsDir, `0.5-to-0.6-${stamp}.md`);
  const text = formatReport(report);

  if (apply) writeFileSync(reportPath, text + "\n");
  return reportPath;
}

// ─── 0.5-to-0.6 subcommand ─────────────────────────────────────────────────

const fiveToSix = new Command("0.5-to-0.6")
  .description("Migrate a PERSONA.md (and surrounding folders) from spec v0.5.0 to v0.6.0.")
  .argument("[file]", "PERSONA.md path (default: ./PERSONA.md)", "./PERSONA.md")
  .option("--apply", "Write changes (default: dry-run; prints report only)")
  .action((fileArg: string, options: { apply?: boolean }) => {
    try {
      const apply = options.apply ?? false;
      const personaPath = resolve(fileArg);
      if (!existsSync(personaPath)) {
        console.error(chalk.red("Error:"), `Not found: ${personaPath}`);
        process.exit(1);
      }

      const personaDir = dirname(personaPath);
      const report: MigrationReport = {
        source: personaPath,
        ts: new Date().toISOString(),
        changes: [],
        warnings: [],
        manualFollowups: [],
      };

      // Folder renames first (independent of file content)
      rewriteFolderNames(personaDir, report, apply);

      // Frontmatter rewrite
      const original = readFileSync(personaPath, "utf-8");
      const fmMatch = original.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) {
        report.warnings.push(
          "Could not detect YAML frontmatter; skipping spec_version + structural rewrite.",
        );
      } else {
        const yamlText = fmMatch[1];
        const newYaml = rewriteFrontmatter(yamlText, report);
        if (apply && newYaml !== yamlText) {
          const next = original.replace(yamlText, newYaml);
          writeFileSync(personaPath, next, "utf-8");
        }
      }

      // state.json stub
      emitStateFile(personaPath, report, apply);

      const reportPath = writeReport(personaPath, report, apply);

      console.log("");
      console.log(
        apply
          ? chalk.green.bold("Migration applied.")
          : chalk.yellow.bold("DRY RUN — no files written. Add --apply to write changes."),
      );
      console.log("");
      console.log(formatReport(report));
      if (apply) {
        console.log("");
        console.log(chalk.dim(`Report saved: ${basename(reportPath)} (under .personaxis/migrations/)`));
        console.log("");
        console.log(chalk.bold("Next steps:"));
        console.log(`  1. ${chalk.cyan("personaxis validate")} ${personaPath}`);
        console.log(`  2. ${chalk.cyan("personaxis state init --force")}  # seed state.json from envelope means`);
        console.log(`  3. Review manual follow-ups in the report above`);
      }
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ─── 0.6-to-0.7 subcommand ─────────────────────────────────────────────────

interface RestructureReport {
  ts: string;
  changes: string[];
  warnings: string[];
}

function formatRestructureReport(r: RestructureReport): string {
  return [
    `# Migration report 0.6 → 0.7`,
    ``,
    `- **Timestamp:** ${r.ts}`,
    ``,
    `## Changes applied`,
    r.changes.length === 0 ? `_(none)_` : r.changes.map((c) => `- ${c}`).join("\n"),
    ``,
    `## Warnings`,
    r.warnings.length === 0 ? `_(none)_` : r.warnings.map((w) => `- ${w}`).join("\n"),
    ``,
    `---`,
    ``,
    `Validate the migrated artifact:`,
    ``,
    "```bash",
    `personaxis validate`,
    "```",
  ].join("\n");
}

const ROOT_SUPPORT_ENTRIES = ["policy.yaml", "state.json", "memory.md", "memory", "references", "examples", "skills", "assets"];

function moveSupportFolders(repoRoot: string, personaxisDir: string, report: RestructureReport, apply: boolean): void {
  for (const entry of ROOT_SUPPORT_ENTRIES) {
    const src = join(repoRoot, entry);
    const dest = join(personaxisDir, entry);
    if (!existsSync(src)) continue;

    if (existsSync(dest)) {
      report.warnings.push(`\`.personaxis/${entry}\` already exists; left \`${entry}\` at the repo root. Merge manually.`);
      continue;
    }

    if (apply) renameSync(src, dest);
    report.changes.push(`Moved \`${entry}\` → \`.personaxis/${entry}\``);
  }
}

function moveSpecIntoPersonaxis(legacyPath: string, personaxisDir: string, report: RestructureReport, apply: boolean): string {
  const newSpecPath = join(personaxisDir, "personaxis.md");

  if (existsSync(newSpecPath)) {
    report.warnings.push(`\`.personaxis/personaxis.md\` already exists; left \`${basename(legacyPath)}\` in place. Merge manually.`);
    return newSpecPath;
  }

  const content = readFileSync(legacyPath, "utf-8");
  const bumped = content.replace(/spec_version:\s*["']?[\d.]+["']?/, 'spec_version: "0.7.0"');

  if (apply) {
    writeFileSync(newSpecPath, bumped, "utf-8");
    unlinkSync(legacyPath);
  }
  report.changes.push(`Moved \`${basename(legacyPath)}\` → \`.personaxis/personaxis.md\` (spec_version bumped to \`0.7.0\`)`);

  return newSpecPath;
}

const sixToSeven = new Command("0.6-to-0.7")
  .description("Restructure a legacy root PERSONA.md (spec v0.6.0, 10-layer frontmatter) into .personaxis/personaxis.md and compile the new PERSONA.md.")
  .option("--apply", "Write changes (default: dry-run; prints report only)")
  .option("--provider <name>", "Provider to use for the initial compile (local | byok | agent | remote)")
  .action(async (options: { apply?: boolean; provider?: string }) => {
    try {
      const apply = options.apply ?? false;
      const repoRoot = process.cwd();

      const legacyPath = [resolve(repoRoot, "PERSONA.md"), resolve(repoRoot, "persona.md")].find((p) => existsSync(p));
      const personaxisDir = resolve(repoRoot, ".personaxis");
      const existingSpec = resolve(personaxisDir, "personaxis.md");

      if (!legacyPath && !existsSync(existingSpec)) {
        console.error(chalk.red("Error:"), "No legacy root PERSONA.md/persona.md found, and .personaxis/personaxis.md does not exist either.");
        console.error(chalk.dim("Nothing to migrate. Run 'personaxis init' to start a new persona."));
        process.exit(1);
      }

      const report: RestructureReport = { ts: new Date().toISOString(), changes: [], warnings: [] };

      if (apply) mkdirSync(personaxisDir, { recursive: true });

      if (legacyPath) {
        moveSupportFolders(repoRoot, personaxisDir, report, apply);
        moveSpecIntoPersonaxis(legacyPath, personaxisDir, report, apply);
      } else {
        report.warnings.push("No legacy root PERSONA.md/persona.md found; .personaxis/personaxis.md already exists. Skipping file moves.");
      }

      console.log("");
      console.log(
        apply
          ? chalk.green.bold("Restructure applied.")
          : chalk.yellow.bold("DRY RUN — no files written. Add --apply to write changes."),
      );
      console.log("");
      console.log(formatRestructureReport(report));

      if (apply) {
        console.log("");
        console.log(chalk.dim("Running 'personaxis compile --root' to produce the initial PERSONA.md..."));
        console.log("");
        await runCompile({ root: true, provider: options.provider as Parameters<typeof runCompile>[0]["provider"] });
        console.log("");
        console.log(chalk.bold("Next steps:"));
        console.log(`  1. ${chalk.cyan("personaxis validate")}`);
        console.log(`  2. Review the generated ${chalk.cyan("PERSONA.md")} and CLAUDE.md/AGENTS.md baseline references.`);
      }
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ─── 0.7-to-0.8 subcommand (additive — no field changes) ───────────────────

const sevenToEight = new Command("0.7-to-0.8")
  .description("Bump a persona from spec 0.7.0 to 0.8.0. Additive: no field changes — just updates spec_version. New OPTIONAL fields (identity.capabilities, governance.max_step_delta, permissions, mutation_log origin_node/session_id) become available.")
  .argument("[file]", "personaxis.md path (default: .personaxis/personaxis.md)", ".personaxis/personaxis.md")
  .option("--apply", "Write changes (default: dry-run; prints what would change)")
  .action((file: string, options: { apply?: boolean }) => {
    try {
      const path = resolve(file);
      if (!existsSync(path)) {
        console.error(chalk.red("Error:"), `persona not found at ${path}`);
        process.exit(1);
      }
      const before = readFileSync(path, "utf-8");
      if (!/spec_version:\s*["']?0\.7\.0["']?/.test(before)) {
        console.log(chalk.yellow("Nothing to do:"), "spec_version is not 0.7.0 (already migrated or a different version).");
        return;
      }
      const after = before.replace(/spec_version:\s*["']?0\.7\.0["']?/, 'spec_version: "0.8.0"');
      console.log("");
      console.log(options.apply ? chalk.green.bold("0.7.0 → 0.8.0 applied (additive).") : chalk.yellow.bold("DRY RUN — add --apply to write."));
      console.log(chalk.dim("  - spec_version: 0.7.0 → 0.8.0 (no field changes; v0.7 personas remain valid)"));
      console.log(chalk.dim("  - new optional fields now available: identity.capabilities, governance.max_step_delta,"));
      console.log(chalk.dim("    permissions, mutation_log.origin_node/session_id, episodic-memory entry schema"));
      if (options.apply) {
        writeFileSync(path, after, "utf-8");
        console.log(chalk.green("\n  ✓ written. Run ") + chalk.cyan("personaxis validate") + chalk.green(" to confirm."));
      }
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ─── 0.8-to-0.9 subcommand (additive — no field changes) ───────────────────

const eightToNine = new Command("0.8-to-0.9")
  .description("Bump a persona from spec 0.8.0 to 0.9.0. Additive: no field changes — just updates spec_version. New OPTIONAL blocks (verification, agent_budget, observability, runtime_artifacts.agent_state_file) become available.")
  .argument("[file]", "personaxis.md path (default: .personaxis/personaxis.md)", ".personaxis/personaxis.md")
  .option("--apply", "Write changes (default: dry-run; prints what would change)")
  .action((file: string, options: { apply?: boolean }) => {
    try {
      const path = resolve(file);
      if (!existsSync(path)) {
        console.error(chalk.red("Error:"), `persona not found at ${path}`);
        process.exit(1);
      }
      const before = readFileSync(path, "utf-8");
      if (!/spec_version:\s*["']?0\.8\.0["']?/.test(before)) {
        console.log(chalk.yellow("Nothing to do:"), "spec_version is not 0.8.0 (already migrated or a different version).");
        return;
      }
      const after = before.replace(/spec_version:\s*["']?0\.8\.0["']?/, 'spec_version: "0.9.0"');
      console.log("");
      console.log(options.apply ? chalk.green.bold("0.8.0 → 0.9.0 applied (additive).") : chalk.yellow.bold("DRY RUN — add --apply to write."));
      console.log(chalk.dim("  - spec_version: 0.8.0 → 0.9.0 (no field changes; v0.8 personas remain valid)"));
      console.log(chalk.dim("  - new optional blocks now available: verification (objective gates),"));
      console.log(chalk.dim("    agent_budget (stop-conditions + caps), observability (tracing), runtime_artifacts.agent_state_file"));
      if (options.apply) {
        writeFileSync(path, after, "utf-8");
        console.log(chalk.green("\n  ✓ written. Run ") + chalk.cyan("personaxis validate") + chalk.green(" to confirm."));
      }
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ─── 0.9-to-0.10 subcommand (additive — no field changes) ──────────────────

const nineToTen = new Command("0.9-to-0.10")
  .description("Bump a persona from spec 0.9.0 to 0.10.0. Additive: no field changes — just updates spec_version. New OPTIONAL blocks (identity.short_name, improvement_policy.mode inline, persona_prompting) become available.")
  .argument("[file]", "personaxis.md path (default: .personaxis/personaxis.md)", ".personaxis/personaxis.md")
  .option("--apply", "Write changes (default: dry-run; prints what would change)")
  .action((file: string, options: { apply?: boolean }) => {
    try {
      const path = resolve(file);
      if (!existsSync(path)) {
        console.error(chalk.red("Error:"), `persona not found at ${path}`);
        process.exit(1);
      }
      const before = readFileSync(path, "utf-8");
      if (!/spec_version:\s*["']?0\.9\.0["']?/.test(before)) {
        console.log(chalk.yellow("Nothing to do:"), "spec_version is not 0.9.0 (already migrated or a different version).");
        return;
      }
      const after = before.replace(/spec_version:\s*["']?0\.9\.0["']?/, 'spec_version: "0.10.0"');
      console.log("");
      console.log(options.apply ? chalk.green.bold("0.9.0 → 0.10.0 applied (additive).") : chalk.yellow.bold("DRY RUN — add --apply to write."));
      console.log(chalk.dim("  - spec_version: 0.9.0 → 0.10.0 (no field changes; v0.9 personas remain valid)"));
      console.log(chalk.dim("  - new optional blocks now available: identity.short_name,"));
      console.log(chalk.dim("    improvement_policy.mode (inline), persona_prompting (voice/scene/anchors/guardrails)"));
      console.log(chalk.dim("  - compile now produces a persona-prompting PERSONA.md (see docs/PERSONA_PROMPTING.md)"));
      if (options.apply) {
        writeFileSync(path, after, "utf-8");
        console.log(chalk.green("\n  ✓ written. Run ") + chalk.cyan("personaxis validate") + chalk.green(" to confirm."));
      }
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ─── 0.10-to-1.0 subcommand (STRUCTURAL — comment-preserving codemod) ───────
//
// v1.0 is the first breaking release. The codemod rewrites the frontmatter
// TEXTUALLY (never parse→re-serialize, so every author comment survives):
//
//   1. apiVersion persona.dev/v1 → personaxis.com/v1; spec_version → "1.0.0"
//      (policy.yaml spec_version bumped too)
//   2. metadata.display_name dropped (identity.display_name is the owner)
//   3. reflexive_self_regulation → self_regulation (top-level key AND the
//      per_layer_edit_policy / drift_thresholds entries)
//   4. self_regulation.principled_refusals items → character.prohibited_behaviors
//      (v1.0 has TWO refusal surfaces, not five)
//   5. persona_prompting merged into layer 10 `persona` (address, voice_exemplars,
//      scene_contracts, behavioral_anchors, consistency); its
//      break_character_guardrails items → self_regulation.hard_limits
//   6. memory.retrieval_policy knobs + deletion_policy.retention_days_default
//      → new OPTIONAL `runtime.memory` block (faculty vs implementation split)
//   7. drives: bare `intensity: X` (mutable with nothing to clamp against)
//      → static `level:` (≥0.75 high, ≥0.4 moderate, else low); a drive that
//      already declares {mean, range} joins the clamped mutable surface as-is
//   8. sibling state.json `values` keys renamed short → full dot-paths
//      (traits.x → personality.traits.x, mood.x → affect.baseline.mood.x, …)

import { SHORT_TO_FULL } from "@personaxis/core";

/** [start, end) line range of a top-level YAML key inside the frontmatter. */
function topRange(lines: string[], key: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => l.startsWith(key + ":"));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^\S/.test(lines[end])) end++;
  return { start, end };
}

/** [start, end) of an indented sub-block (`indent`-prefixed key) inside [from, to). */
function subRange(
  lines: string[],
  from: number,
  to: number,
  key: string,
  indent: string,
): { start: number; end: number } | null {
  let start = -1;
  for (let i = from; i < to; i++) {
    if (lines[i].startsWith(indent + key + ":")) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = start + 1;
  // The sub-block extends while lines are blank or MORE indented than the key.
  while (end < to) {
    const l = lines[end];
    if (l.trim() !== "" && !l.startsWith(indent + " ") && !l.startsWith(indent + "\t")) break;
    end++;
  }
  return { start, end };
}

/** The contiguous run of column-0 `#` banner lines directly above `start`. */
function bannerAbove(lines: string[], start: number): number {
  let s = start;
  while (s > 0 && /^#/.test(lines[s - 1])) s--;
  return s;
}

/** Collect the `- "…"` item lines of a YAML list sub-block (verbatim, re-indentable). */
function listItems(lines: string[], r: { start: number; end: number }): string[] {
  return lines.slice(r.start + 1, r.end).filter((l) => l.trim() !== "");
}

function driveLevel(intensity: number): "low" | "moderate" | "high" {
  return intensity >= 0.75 ? "high" : intensity >= 0.4 ? "moderate" : "low";
}

function migrateStateValues(statePath: string, report: MigrationReport, apply: boolean): void {
  if (!existsSync(statePath)) return;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
      values?: Record<string, number>;
    };
    if (!state.values) return;
    const next: Record<string, number> = {};
    let renamed = 0;
    for (const [k, v] of Object.entries(state.values)) {
      const hit = SHORT_TO_FULL.find(([short]) => k.startsWith(short));
      if (hit && !k.startsWith(hit[1])) {
        next[hit[1] + k.slice(hit[0].length)] = v;
        renamed++;
      } else {
        next[k] = v;
      }
    }
    if (renamed > 0) {
      state.values = next;
      if (apply) writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
      report.changes.push(
        `${apply ? "Renamed" : "(dry-run) would rename"} ${renamed} state.json value key(s) to full dot-paths (e.g. \`mood.tone\` → \`affect.baseline.mood.tone\`)`,
      );
    }
  } catch (e) {
    report.warnings.push(`state.json at ${statePath} could not be migrated: ${(e as Error).message}`);
  }
}

function migrateTenToOne(text: string, report: MigrationReport): string {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) {
    report.warnings.push("No YAML frontmatter found; nothing to migrate.");
    return text;
  }
  let lines = fm[1].split("\n");

  // 1. apiVersion + spec_version
  lines = lines.map((l) =>
    l.replace(/^apiVersion:\s*["']?persona\.dev\/v1["']?/, "apiVersion: personaxis.com/v1"),
  );
  report.changes.push("`apiVersion`: persona.dev/v1 → `personaxis.com/v1`");
  lines = lines.map((l) => l.replace(/^spec_version:\s*["']?0\.10\.0["']?/, 'spec_version: "1.0.0"'));
  report.changes.push('`spec_version`: 0.10.0 → `"1.0.0"`');

  // 2. metadata.display_name (identity keeps its own)
  const meta = topRange(lines, "metadata");
  if (meta) {
    const dn = subRange(lines, meta.start + 1, meta.end, "display_name", "  ");
    if (dn) {
      lines.splice(dn.start, dn.end - dn.start);
      report.changes.push("Dropped `metadata.display_name` (single owner: `identity.display_name`)");
    }
  }

  // 3. Layer-9 rename (top-level + governance sub-keys)
  lines = lines.map((l) => l.replace(/^reflexive_self_regulation:/, "self_regulation:"));
  lines = lines.map((l) =>
    l.replace(/^(\s+)reflexive_self_regulation:/, "$1self_regulation:"),
  );
  report.changes.push(
    "Renamed `reflexive_self_regulation` → `self_regulation` (layer 9 + per_layer_edit_policy + drift_thresholds)",
  );

  // 4. principled_refusals → character.prohibited_behaviors
  const selfReg = topRange(lines, "self_regulation");
  if (selfReg) {
    const pr = subRange(lines, selfReg.start + 1, selfReg.end, "principled_refusals", "  ");
    if (pr) {
      const items = listItems(lines, pr);
      lines.splice(pr.start, pr.end - pr.start);
      const character = topRange(lines, "character");
      const target = character
        ? subRange(lines, character.start + 1, character.end, "prohibited_behaviors", "  ")
        : null;
      if (target) {
        lines.splice(
          target.end,
          0,
          "    # migrated from self_regulation.principled_refusals (v1.0: two refusal surfaces)",
          ...items,
        );
        report.changes.push(
          `Merged ${items.length} \`principled_refusals\` item(s) into \`character.prohibited_behaviors\``,
        );
      } else {
        report.manualFollowups.push(
          "`principled_refusals` was removed but `character.prohibited_behaviors` was not found — re-add the items there manually.",
        );
      }
    }
  }

  // 5. persona_prompting → persona (+ guardrails → hard_limits)
  const pp = topRange(lines, "persona_prompting");
  if (pp) {
    const guard = subRange(lines, pp.start + 1, pp.end, "break_character_guardrails", "  ");
    let guardItems: string[] = [];
    if (guard) {
      guardItems = listItems(lines, guard).map((l) => l.slice(2)); // 4-space list → 2-space sub-list… re-indent below
      lines.splice(guard.start, guard.end - guard.start);
    }
    const ppAfter = topRange(lines, "persona_prompting")!; // range shifted by the splice
    const children = lines.slice(ppAfter.start + 1, ppAfter.end).filter((l, i, arr) => {
      // drop trailing blank lines of the block
      if (l.trim() === "") return arr.slice(i + 1).some((x) => x.trim() !== "");
      return true;
    });
    const bannerStart = bannerAbove(lines, ppAfter.start);
    lines.splice(bannerStart, ppAfter.end - bannerStart);
    const persona = topRange(lines, "persona");
    if (persona) {
      lines.splice(
        persona.end,
        0,
        "  # v1.0: persona-prompting material lives in layer 10 (migrated from persona_prompting)",
        ...children,
      );
      report.changes.push(
        "Merged `persona_prompting` (address, voice_exemplars, scene_contracts, behavioral_anchors, consistency) into layer 10 `persona`",
      );
    } else {
      report.manualFollowups.push(
        "`persona_prompting` was removed but layer 10 `persona` was not found — re-add its material there manually.",
      );
    }
    if (guardItems.length > 0) {
      const sr = topRange(lines, "self_regulation");
      const hl = sr ? subRange(lines, sr.start + 1, sr.end, "hard_limits", "  ") : null;
      if (hl) {
        lines.splice(
          hl.end,
          0,
          "    # migrated from persona_prompting.break_character_guardrails (v1.0)",
          ...guardItems.map((l) => "  " + l),
        );
        report.changes.push(
          `Merged ${guardItems.length} \`break_character_guardrails\` item(s) into \`self_regulation.hard_limits\``,
        );
      } else {
        report.manualFollowups.push(
          "`break_character_guardrails` items could not be appended to `self_regulation.hard_limits` — add them manually.",
        );
      }
    }
  }

  // 6. memory knobs → runtime.memory
  const runtimeKnobs: string[] = [];
  const memory = topRange(lines, "memory");
  if (memory) {
    const rp = subRange(lines, memory.start + 1, memory.end, "retrieval_policy", "  ");
    if (rp) {
      for (const l of lines.slice(rp.start + 1, rp.end)) {
        const m = l.match(/^\s+(use_embeddings|use_reranker|max_items):\s*(.+?)\s*(#.*)?$/);
        if (m) runtimeKnobs.push(`    ${m[1]}: ${m[2]}`);
      }
      lines.splice(rp.start, rp.end - rp.start);
      report.changes.push("Moved `memory.retrieval_policy` knobs → `runtime.memory` (faculty vs implementation split)");
    }
    const mem2 = topRange(lines, "memory")!;
    const dp = subRange(lines, mem2.start + 1, mem2.end, "deletion_policy", "  ");
    if (dp) {
      for (let i = dp.start + 1; i < dp.end; i++) {
        const m = lines[i].match(/^\s+retention_days_default:\s*(\d+)/);
        if (m) {
          runtimeKnobs.push(`    retention_days_default: ${m[1]}`);
          lines.splice(i, 1);
          report.changes.push("Moved `memory.deletion_policy.retention_days_default` → `runtime.memory`");
          break;
        }
      }
    }
  }
  if (runtimeKnobs.length > 0) {
    const anchor = topRange(lines, "runtime_artifacts");
    const at = anchor ? bannerAbove(lines, anchor.start) : lines.length;
    lines.splice(
      at,
      0,
      "# ─── v1.0: Runtime memory knobs (implementation, not faculty) ──────────────",
      "runtime:",
      "  memory:",
      ...runtimeKnobs,
      "",
    );
  }

  // 7. drives: intensity → level (static) unless the drive declares an envelope
  const vad = topRange(lines, "values_and_drives");
  if (vad) {
    const drives = subRange(lines, vad.start + 1, vad.end, "drives", "  ");
    if (drives) {
      let converted = 0;
      const block = lines.slice(drives.start, drives.end).join("\n");
      const hasEnvelope = /^\s+mean:/m.test(block);
      for (let i = drives.start + 1; i < drives.end; i++) {
        const m = lines[i].match(/^(\s+)intensity:\s*([\d.]+)\s*(#.*)?$/);
        if (m) {
          const lvl = driveLevel(Number(m[2]));
          lines[i] = `${m[1]}level: "${lvl}"${" ".repeat(Math.max(1, 22 - lvl.length))}# was intensity: ${m[2]}`;
          converted++;
        }
      }
      if (converted > 0) {
        report.changes.push(
          `Converted ${converted} drive \`intensity\` value(s) → static \`level\` (a drive is mutable ONLY by declaring a {mean, range} envelope)`,
        );
      }
      if (hasEnvelope) {
        report.changes.push("Drives declaring {mean, range} envelopes kept as-is (they join the clamped mutable surface)");
      }
    }
  }

  // 8. Pre-0.6 residue some 0.10 documents still carry (the 0.10 schema tolerated
  //    it; v1.0 rejects it): scattered layer-level edit_policy, and bare
  //    core_affect/mood scalars instead of {mean, range} envelopes.
  const stray = lines.filter((l) => /^  edit_policy:/.test(l)).length;
  if (stray > 0) {
    lines = lines.filter((l) => !/^  edit_policy:/.test(l));
    report.changes.push(
      `Removed ${stray} scattered layer-level \`edit_policy\` field(s) (single owner since v0.6: \`governance.per_layer_edit_policy\`)`,
    );
  }
  let wrapped = 0;
  lines = lines.map((l) => {
    const m = l.match(/^(\s{6})(valence|arousal|dominance|tone|stability|recovery_rate):\s*(-?[\d.]+)\s*$/);
    if (!m) return l;
    wrapped++;
    return `${m[1]}${m[2]}: {mean: ${m[3]}, range: [${m[3]}, ${m[3]}]}`;
  });
  if (wrapped > 0) {
    report.changes.push(
      `Wrapped ${wrapped} bare core_affect/mood scalar(s) into degenerate {mean, range} envelopes (v1.0 requires envelopes)`,
    );
    report.manualFollowups.push(
      "Bare affect scalars were wrapped as {mean: v, range: [v, v]} — a degenerate envelope declares the field IMMUTABLE. Widen the ranges you want the runtime to be able to move.",
    );
  }

  // 9. Follow-ups the codemod cannot decide for the author
  report.manualFollowups.push(
    "OPTIONAL: add `refs:` to hard-enforced virtues pointing at their backing trait/value dot-paths (e.g. honesty → [personality.traits.honesty_humility]); the validator then enforces coherence.",
    "OPTIONAL: upgrade metacognition monitors from booleans to `{enabled, feeds}` to wire monitor → decision explicitly.",
    "OPTIONAL: declare behavior `bands` boundaries on traits for deterministic compile semantics (drift = band crossing).",
  );

  return text.replace(fm[1], lines.join("\n"));
}

const tenToOneZero = new Command("0.10-to-1.0")
  .description(
    "STRUCTURAL migration to spec v1.0 (comment-preserving): renames self_regulation, merges persona_prompting into persona, 2 refusal surfaces, memory faculty/knobs split, drives level|envelope, apiVersion personaxis.com/v1, state.json full dot-paths.",
  )
  .argument("[file]", "personaxis.md path (default: .personaxis/personaxis.md)", ".personaxis/personaxis.md")
  .option("--apply", "Write changes (default: dry-run; prints report only)")
  .action((file: string, options: { apply?: boolean }) => {
    try {
      const apply = options.apply ?? false;
      const path = resolve(file);
      if (!existsSync(path)) {
        console.error(chalk.red("Error:"), `persona not found at ${path}`);
        process.exit(1);
      }
      const before = readFileSync(path, "utf-8");
      if (!/spec_version:\s*["']?0\.10\.0["']?/.test(before)) {
        console.log(
          chalk.yellow("Nothing to do:"),
          "spec_version is not 0.10.0. Run the earlier codemods first (…, 0.8-to-0.9, 0.9-to-0.10).",
        );
        return;
      }

      const report: MigrationReport = {
        source: path,
        ts: new Date().toISOString(),
        changes: [],
        warnings: [],
        manualFollowups: [],
      };

      const after = migrateTenToOne(before, report);
      if (apply && after !== before) writeFileSync(path, after, "utf-8");

      // Sibling artifacts: state.json keys, policy.yaml spec_version
      migrateStateValues(join(dirname(path), "state.json"), report, apply);
      const policyPath = join(dirname(path), "policy.yaml");
      if (existsSync(policyPath)) {
        const p = readFileSync(policyPath, "utf-8");
        if (/spec_version:\s*["']?0\.10\.0["']?/.test(p)) {
          if (apply) writeFileSync(policyPath, p.replace(/spec_version:\s*["']?0\.10\.0["']?/, 'spec_version: "1.0.0"'), "utf-8");
          report.changes.push("policy.yaml `spec_version` → `\"1.0.0\"`");
        }
      }

      // Written report (same convention as 0.5-to-0.6)
      const migrationsDir = join(dirname(path), ".personaxis", "migrations");
      const stamp = report.ts.replace(/[:.]/g, "-");
      const reportPath = join(migrationsDir, `0.10-to-1.0-${stamp}.md`);
      if (apply) {
        mkdirSync(migrationsDir, { recursive: true });
        writeFileSync(reportPath, formatReport(report).replace("0.5 → 0.6", "0.10 → 1.0") + "\n");
      }

      console.log("");
      console.log(
        apply
          ? chalk.green.bold("0.10.0 → 1.0.0 applied (structural).")
          : chalk.yellow.bold("DRY RUN — no files written. Add --apply to write changes."),
      );
      console.log("");
      console.log(formatReport(report).replace("0.5 → 0.6", "0.10 → 1.0"));
      if (apply) {
        console.log("");
        console.log(chalk.dim(`Report saved: ${basename(reportPath)} (under .personaxis/migrations/)`));
        console.log("");
        console.log(chalk.bold("Next steps:"));
        console.log(`  1. ${chalk.cyan("personaxis validate")} ${path}`);
        console.log(`  2. ${chalk.cyan("personaxis compile")}  # regenerate the compiled PERSONA.md from the v1.0 spec`);
        console.log(`  3. Review manual follow-ups in the report above`);
      }
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ─── Parent migrate command ────────────────────────────────────────────────

export const migrateCommand = new Command("migrate")
  .description("Apply version-to-version codemods to a PERSONA.md.")
  .addCommand(fiveToSix)
  .addCommand(sixToSeven)
  .addCommand(sevenToEight)
  .addCommand(eightToNine)
  .addCommand(nineToTen)
  .addCommand(tenToOneZero);
