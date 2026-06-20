import { Command } from "commander";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import chalk from "chalk";
import { lint } from "../linter/index.js";
import type { Finding } from "../linter/types.js";

function severityColor(f: Finding): string {
  if (f.severity === "error") return chalk.red(`  error  `);
  if (f.severity === "warning") return chalk.yellow(`  warning`);
  return chalk.dim(`  info   `);
}

export const lintCommand = new Command("lint")
  .description("Lint a PERSONA.md for structural and semantic issues")
  .argument("[file]", "Path to PERSONA.md (defaults to ./PERSONA.md)")
  .option("--format <format>", "Output format: text (default) or json", "text")
  .action((file: string | undefined, opts: { format: string }) => {
    const candidates = file
      ? [resolve(file)]
      : [resolve(process.cwd(), "PERSONA.md"), resolve(process.cwd(), "persona.md")];

    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      console.error(chalk.red("Error:"), "No PERSONA.md found.");
      process.exit(1);
    }

    const raw = readFileSync(found, "utf-8");
    const report = lint(raw);

    if (opts.format === "json") {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exit(report.summary.errors > 0 ? 1 : 0);
    }

    console.log("");

    if (report.findings.length === 0) {
      console.log(chalk.green("  No findings."));
    } else {
      for (const f of report.findings) {
        const path = f.path ? chalk.cyan(f.path.padEnd(42)) : " ".repeat(42);
        console.log(`${severityColor(f)} ${path} ${f.message}`);
      }
    }

    console.log("");

    const { errors, warnings, infos } = report.summary;
    const parts: string[] = [];
    if (errors > 0) parts.push(chalk.red(`${errors} error${errors !== 1 ? "s" : ""}`));
    if (warnings > 0) parts.push(chalk.yellow(`${warnings} warning${warnings !== 1 ? "s" : ""}`));
    if (infos > 0) parts.push(chalk.dim(`${infos} info`));
    console.log("  " + (parts.length > 0 ? parts.join(", ") : chalk.green("clean")));
    console.log("");

    process.exit(errors > 0 ? 1 : 0);
  });
