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

// ─── Parent migrate command ────────────────────────────────────────────────

export const migrateCommand = new Command("migrate")
  .description("Apply version-to-version codemods to a PERSONA.md.")
  .addCommand(fiveToSix)
  .addCommand(sixToSeven);
