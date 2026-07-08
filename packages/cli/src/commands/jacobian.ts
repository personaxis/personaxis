/**
 * `personaxis jacobian` — J_compile: which coordinates actually matter.
 *
 * The deterministic compile stage is a step function of each coordinate's band,
 * so its sensitivity is EXACT (MATH_CORE.md Def. 10): compile at each reachable
 * band's representative, measure normalized line-edit distance between adjacent
 * bands. σ = 0 ⇒ the number is decorative — it provably cannot change the
 * compiled artifact (the audit's F-21, made measurable). No LLM, offline.
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  loadPersona,
  extractEnvelopes,
  readState,
  assemblePersonaDoc,
  jacobianCompile,
} from "@personaxis/core";
import { resolvePersonaSourcePath } from "../load.js";
import { existsSync } from "node:fs";

function personaName(fm: Record<string, unknown>): string {
  const id = fm.identity as { short_name?: string; display_name?: string } | undefined;
  const meta = fm.metadata as { name?: string } | undefined;
  return id?.short_name ?? id?.display_name ?? meta?.name ?? "Persona";
}

export const jacobianCommand = new Command("jacobian")
  .description("Persona Jacobian (J_compile): exact per-coordinate sensitivity of the compiled artifact; σ=0 flags decorative numbers.")
  .option("-f, --file <path>", "Path to the persona (default: resolved from cwd)")
  .option("--json", "Output the report as JSON")
  .action((options: { file?: string; json?: boolean }) => {
    try {
      const source = resolvePersonaSourcePath(options.file);
      const handle = loadPersona(source);
      const fm = handle.frontmatter as Record<string, unknown>;
      const env = extractEnvelopes(handle.frontmatter);
      if (Object.keys(env.envelopes).length === 0) {
        console.error(chalk.red("Error:"), "the persona declares no envelope coordinates.");
        process.exit(1);
      }
      const values = existsSync(handle.statePath) ? readState(handle.statePath).values : {};

      const report = jacobianCompile({
        envelopes: env.envelopes,
        values,
        compile: (v) =>
          assemblePersonaDoc({
            persona: fm,
            target: { name: personaName(fm), isSubagent: false, resourceBase: "./.personaxis/" },
            stateValues: v,
          }),
      });

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(chalk.bold("Persona Jacobian — J_compile") + chalk.dim(`  (${report.compiles} deterministic compiles, no LLM)`));
      console.log(chalk.dim("σ = mean normalized line-edit distance between adjacent band artifacts\n"));
      for (const c of report.coordinates) {
        const bar = "█".repeat(Math.round(c.sigma * 24)).padEnd(24, "·");
        const tag = c.decorative ? chalk.yellow("decorative — value cannot change the artifact") : chalk.dim(Object.entries(c.pairs).map(([k, v]) => `${k} ${v.toFixed(3)}`).join("  "));
        console.log(`  ${chalk.cyan(c.field.padEnd(38))} ${bar} σ ${c.sigma.toFixed(3)}  ${tag}`);
      }
      const dead = report.coordinates.filter((c) => c.decorative);
      if (dead.length > 0) {
        console.log("");
        console.log(
          chalk.yellow(`! ${dead.length} decorative coordinate(s)`) +
            chalk.dim(" — declare per-band `expression` prose to make these numbers load-bearing (SPEC §L3)."),
        );
        process.exitCode = 2;
      }
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });
