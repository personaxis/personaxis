/**
 * `personaxis scan <path...>` — audit agent config files for injection, dangerous
 * permissions, and leaked credentials (cross-harness: personaxis.md, PERSONA.md,
 * CLAUDE.md, AGENTS.md, .cursorrules, .codex/*.toml, agents.json). The free wedge.
 *
 * Exit codes (for CI gates): 0 clean, 1 suspicious, 2 risky, 3 malicious.
 * Also shipped as the standalone `personaxis-scan` bin.
 */

import { Command } from "commander";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import chalk from "chalk";
import { scanAgentConfig, detectKind, type ConfigScanResult, type ScanVerdict } from "@personaxis/core";

const VERDICT_EXIT: Record<ScanVerdict, number> = { clean: 0, suspicious: 1, risky: 2, malicious: 3 };
const VERDICT_COLOR: Record<ScanVerdict, (s: string) => string> = {
  clean: chalk.green, suspicious: chalk.yellow, risky: chalk.hex("#ff8800"), malicious: chalk.red,
};

const CANDIDATE_NAMES = ["personaxis.md", "PERSONA.md", "CLAUDE.md", "AGENTS.md", ".cursorrules", "agents.json"];

function collectFiles(target: string): string[] {
  const p = resolve(target);
  if (!existsSync(p)) return [];
  if (statSync(p).isDirectory()) {
    const out: string[] = [];
    for (const name of CANDIDATE_NAMES) if (existsSync(join(p, name))) out.push(join(p, name));
    return out;
  }
  return [p];
}

function printResult(path: string, r: ConfigScanResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ path, ...r }, null, 2));
    return;
  }
  const color = VERDICT_COLOR[r.verdict];
  console.log(`\n  ${color("●")} ${chalk.bold(basename(path))} ${chalk.dim(`(${r.kind})`)} — ${color(r.verdict.toUpperCase())} ${chalk.dim(`score ${r.score}`)}`);
  if (r.findings.length === 0) {
    console.log(chalk.dim("    no findings"));
    return;
  }
  for (const f of r.findings) {
    const sev = f.severity === "error" ? chalk.red("✗") : f.severity === "warning" ? chalk.yellow("!") : chalk.dim("·");
    console.log(`    ${sev} ${chalk.dim(`[${f.team}]`)} ${f.rule.padEnd(26)} ${f.message}${f.match ? chalk.dim(` — ${f.match}`) : ""}`);
  }
}

export const scanCommand = new Command("scan")
  .description("Security-scan agent config files (cross-harness) for injection, dangerous permissions, and leaked secrets.")
  .argument("<paths...>", "Config files or directories to scan")
  .option("--json", "Output JSON")
  .option("--strict", "Treat 'suspicious' as a failing exit code too")
  .action((paths: string[], opts: { json?: boolean; strict?: boolean }) => {
    const files = paths.flatMap(collectFiles);
    if (files.length === 0) {
      console.error(chalk.red("Error:"), "no config files found at the given path(s)");
      process.exit(1);
    }
    let worst: ScanVerdict = "clean";
    const order: ScanVerdict[] = ["clean", "suspicious", "risky", "malicious"];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      const r = scanAgentConfig(text, detectKind(file));
      printResult(file, r, Boolean(opts.json));
      if (order.indexOf(r.verdict) > order.indexOf(worst)) worst = r.verdict;
    }
    if (!opts.json) console.log("");
    let exit = VERDICT_EXIT[worst];
    if (!opts.strict && worst === "suspicious") exit = 0; // suspicious is non-failing unless --strict
    process.exit(exit);
  });
