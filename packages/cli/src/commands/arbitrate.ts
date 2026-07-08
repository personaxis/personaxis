/**
 * `personaxis arbitrate` — resolve a value conflict deterministically and explain it.
 *
 * The algorithm (MATH_CORE.md Def. 9, spec v1.1 "Mathematical semantics"):
 * governance-typed values dominate; then weight; then lexicographic name. U7
 * (safety_over_completion) is an instance, not an extra rule — safety wins every
 * conflict with a non-governance value by U6. With no arguments, prints the
 * persona's full arbitration ranking.
 */

import { Command } from "commander";
import chalk from "chalk";
import { loadPersona, readArbitrationValues, arbitrate, rankValues } from "@personaxis/core";
import { resolvePersonaSourcePath } from "../load.js";

export const arbitrateCommand = new Command("arbitrate")
  .description("Resolve a conflict between two declared values (deterministic, explained) — or print the full ranking.")
  .argument("[valueA]", "first value name (e.g. safety)")
  .argument("[valueB]", "second value name (e.g. completion)")
  .option("-f, --file <path>", "Path to the persona (default: resolved from cwd)")
  .option("--json", "Output the verdict/ranking as JSON")
  .action((valueA: string | undefined, valueB: string | undefined, options: { file?: string; json?: boolean }) => {
    try {
      const source = resolvePersonaSourcePath(options.file);
      const handle = loadPersona(source);
      const values = readArbitrationValues(handle.frontmatter as Record<string, unknown>);
      if (values.length === 0) {
        console.error(chalk.red("Error:"), "the persona declares no values_and_drives.values with weights.");
        process.exit(1);
      }

      if (!valueA || !valueB) {
        const ranked = rankValues(values);
        if (options.json) {
          console.log(JSON.stringify({ ranking: ranked }, null, 2));
          return;
        }
        console.log(chalk.bold("Arbitration ranking") + chalk.dim("  (governance ≻ weight ≻ name)"));
        ranked.forEach((v, i) => {
          const gov = v.type === "governance" ? chalk.magenta(" [governance]") : "";
          console.log(`  ${String(i + 1).padStart(2)}. ${chalk.cyan(v.name)} ${chalk.dim(`weight ${v.weight}`)}${gov}`);
        });
        return;
      }

      const find = (name: string) => values.find((v) => v.name === name);
      const a = find(valueA);
      const b = find(valueB);
      for (const [name, v] of [[valueA, a], [valueB, b]] as const) {
        if (!v) {
          console.error(
            chalk.red("Error:"),
            `value '${name}' is not declared in values_and_drives.values. Declared: ${values.map((x) => x.name).join(", ")}`,
          );
          process.exit(1);
        }
      }

      const verdict = arbitrate(a!, b!);
      if (options.json) {
        console.log(JSON.stringify({ a, b, verdict }, null, 2));
        return;
      }
      console.log(chalk.green("✓"), `${chalk.bold(verdict.winner)} prevails over ${verdict.loser}`);
      console.log(chalk.dim(`  rule: ${verdict.rule}`));
      console.log(`  ${verdict.trace}`);
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });
