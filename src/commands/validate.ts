import { Command } from "commander";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { resolve, join, dirname, relative } from "path";
import chalk from "chalk";
import { loadPersonaFile, isSubagentPath, slugFromPath, type LoadResult } from "../load.js";
import { validatePersona, exitCodeFor, type ValidationResult, type ValidationStatus } from "../schema.js";
import { locateSiblingPolicy, loadPolicyFile, validatePolicy } from "../policy.js";
import { hashContent, loadManifest } from "../manifest.js";

function statusBadge(status: ValidationStatus): string {
  switch (status) {
    case "PASS": return chalk.green.bold("PASS");
    case "PASS_WITH_WARNINGS": return chalk.yellow.bold("PASS_WITH_WARNINGS");
    case "FAIL_SCHEMA": return chalk.red.bold("FAIL_SCHEMA");
    case "FAIL_POLICY": return chalk.red.bold("FAIL_POLICY");
    case "FAIL_CONCEPTUAL": return chalk.red.bold("FAIL_CONCEPTUAL");
  }
}

function printResult(personaPath: string, name: string, result: ValidationResult): void {
  const badge = statusBadge(result.status);
  const marker = result.valid ? chalk.green("✓") : chalk.red("✗");
  console.log(`${marker} ${chalk.bold(name)} ${chalk.dim(`(${personaPath})`)} ${badge}`);

  for (const err of result.errors) {
    const field = err.field ? chalk.yellow(err.field) + " — " : "";
    console.error(`    ${chalk.red("✗")} ${field}${err.message}`);
  }
  for (const w of result.warnings) {
    const field = w.field ? chalk.cyan(w.field) + " — " : "";
    console.log(`    ${chalk.yellow("!")} ${field}${w.message}`);
  }
}

/**
 * B.7: secondary check against `.personaxis/[personas/<slug>/]manifest.json` -
 * flags drift between `personaxis.md` and its compiled `PERSONA.md`/`<slug>.md`
 * pair so the user knows to run `personaxis compile`/`push`.
 */
function checkSyncStatus(loaded: LoadResult, result: ValidationResult): void {
  const baseDir = dirname(loaded.path);
  const isSubagent = isSubagentPath(loaded.path);
  const compiledPath = resolve(isSubagent ? `.claude/agents/${slugFromPath(loaded.path)}.md` : "PERSONA.md");
  const compiledRel = relative(process.cwd(), compiledPath).replace(/\\/g, "/");

  const warn = (message: string) => {
    console.log(`    ${chalk.yellow("!")} ${message}`);
    if (result.status === "PASS") result.status = "PASS_WITH_WARNINGS";
  };

  const manifest = loadManifest(baseDir);
  if (!manifest) {
    if (existsSync(compiledPath)) {
      warn(`${compiledRel} exists but no manifest.json was found. Run 'personaxis compile' to establish a baseline.`);
    }
    return;
  }

  if (hashContent(loaded.raw) !== manifest.personaxisMdHash) {
    warn(`personaxis.md changed since the last ${manifest.lastOp}. Run 'personaxis compile' or 'personaxis push' to refresh ${compiledRel}.`);
  }

  if (!existsSync(compiledPath)) {
    warn(`${compiledRel} not found. Run 'personaxis compile'.`);
  } else if (hashContent(readFileSync(compiledPath, "utf-8")) !== manifest.compiledMdHash) {
    warn(`${compiledRel} was hand-edited since the last ${manifest.lastOp}. Run 'personaxis push' (decompiles) or 'personaxis compile' (overwrites it from personaxis.md).`);
  }
}

function validateFile(filePath?: string): ValidationResult {
  let loaded;
  try {
    loaded = loadPersonaFile(filePath);
  } catch (err) {
    console.error(chalk.red("Error:"), (err as Error).message);
    return { status: "FAIL_SCHEMA", valid: false, errors: [{ field: "", message: (err as Error).message, category: "FAIL_SCHEMA" }], warnings: [] };
  }

  const result = validatePersona(loaded.data);
  const name = loaded.data.metadata?.display_name ?? loaded.data.metadata?.name ?? "persona";
  printResult(loaded.path, String(name), result);

  // Spec v0.5.0+ ships with a sibling policy.yaml. Validate it too if
  // present. Absent is a SHOULD warning, not a hard fail (legacy v0.4
  // files may still be valid PERSONA.md without a sibling policy).
  const specVersion = loaded.data.spec_version;
  const policyPath = locateSiblingPolicy(loaded.path);

  if (policyPath) {
    try {
      const policyLoad = loadPolicyFile(policyPath);
      const policyResult = validatePolicy(policyLoad.data, loaded.data.metadata?.name);
      const sub = chalk.dim("  └─ policy.yaml");
      if (!policyResult.valid) {
        console.log(`${sub} ${chalk.red.bold("FAIL_SCHEMA")}`);
        for (const e of policyResult.errors) {
          console.error(`     ${chalk.red("✗")} ${chalk.yellow(e.field)} — ${e.message}`);
        }
        result.errors.push(...policyResult.errors.map((e) => ({ ...e, category: "FAIL_SCHEMA" as const })));
        result.status = "FAIL_SCHEMA";
        result.valid = false;
      } else {
        const tag = policyResult.warnings.length > 0 ? chalk.yellow.bold("PASS_WITH_WARNINGS") : chalk.green.bold("PASS");
        console.log(`${sub} ${tag}`);
        for (const w of policyResult.warnings) {
          console.log(`     ${chalk.yellow("!")} ${chalk.cyan(w.field)} — ${w.message}`);
        }
        if (policyResult.warnings.length > 0 && result.status === "PASS") {
          result.status = "PASS_WITH_WARNINGS";
        }
      }
    } catch (err) {
      console.error(chalk.red("  └─ policy.yaml load error:"), (err as Error).message);
      result.errors.push({ field: "policy.yaml", message: (err as Error).message, category: "FAIL_SCHEMA" });
      result.status = "FAIL_SCHEMA";
      result.valid = false;
    }
  } else if (specVersion === "0.5.0" || specVersion === "0.6.0") {
    console.log(`  ${chalk.yellow("!")} sibling policy.yaml not found. spec_version ${specVersion} expects one. Run 'personaxis init' to generate.`);
    if (result.status === "PASS") result.status = "PASS_WITH_WARNINGS";
  }

  checkSyncStatus(loaded, result);

  return result;
}

function worstStatus(a: ValidationStatus, b: ValidationStatus): ValidationStatus {
  const rank: Record<ValidationStatus, number> = {
    PASS: 0,
    PASS_WITH_WARNINGS: 1,
    FAIL_SCHEMA: 2,
    FAIL_POLICY: 3,
    FAIL_CONCEPTUAL: 4,
  };
  return rank[a] >= rank[b] ? a : b;
}

export const validateCommand = new Command("validate")
  .description("Validate personaxis.md + sibling policy.yaml against spec v0.7.0 (v0.3-0.6 accepted with deprecation warnings)")
  .argument("[file]", "Path to personaxis.md, or a subagent slug (defaults to ./.personaxis/personaxis.md)")
  .option("--all", "Validate the root persona + every persona in .personaxis/personas/")
  .action((file?: string, opts?: { all?: boolean }) => {
    if (opts?.all) {
      let aggregateStatus: ValidationStatus = "PASS";
      let count = 0;

      const rootSpec = resolve(process.cwd(), ".personaxis", "personaxis.md");
      const legacyRoot = resolve(process.cwd(), "PERSONA.md");
      const rootPath = existsSync(rootSpec) ? rootSpec : existsSync(legacyRoot) ? legacyRoot : null;
      if (rootPath) {
        console.log("");
        const result = validateFile(rootPath);
        aggregateStatus = worstStatus(aggregateStatus, result.status);
        count++;
      }

      const personasDir = resolve(process.cwd(), ".personaxis", "personas");
      if (existsSync(personasDir)) {
        const slugs = readdirSync(personasDir).filter((name) =>
          statSync(join(personasDir, name)).isDirectory()
        );
        for (const slug of slugs) {
          const p = join(personasDir, slug, "personaxis.md");
          if (existsSync(p)) {
            const result = validateFile(p);
            aggregateStatus = worstStatus(aggregateStatus, result.status);
            count++;
          }
        }
      }

      console.log("");
      console.log(`  ${count} persona${count !== 1 ? "s" : ""} checked. Overall: ${statusBadge(aggregateStatus)}`);
      console.log("");
      process.exit(exitCodeFor(aggregateStatus));
    }

    console.log("");
    const result = validateFile(file);
    console.log("");

    if (!result.valid) {
      console.error(chalk.dim("See "), chalk.cyan("personaxis spec"), chalk.dim(" for the v0.7.0 spec, or "), chalk.cyan("personaxis init"), chalk.dim(" to generate a valid template. Run "), chalk.cyan("personaxis migrate 0.6-to-0.7"), chalk.dim(" to move a legacy root PERSONA.md into .personaxis/personaxis.md."));
      console.error("");
    }
    process.exit(exitCodeFor(result.status));
  });
