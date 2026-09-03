#!/usr/bin/env node
/**
 * `personaxis-evals`, run the governance/property eval suite.
 *
 * Deterministic by default (no API key): exercises the real engine and asserts the
 * invariants that make Personaxis "governed". A regression (e.g. breaking the clamp)
 * fails the suite. Designed to gate CI and to be the evidence behind the moat.
 *
 *   personaxis-evals [--json] [--markdown] [--out <file>] [--compare <report.json>]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { compareReports } from "./compare.js";
import { runScenarios } from "./runner.js";
import { toConsole, toJSON, toMarkdown } from "./report.js";

export { compareReports, asSuiteRun } from "./compare.js";
export { runScenarios } from "./runner.js";
export { SCENARIOS } from "./scenarios.js";
export * from "./types.js";

import type { EvalReport } from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const wantMd = args.includes("--markdown");
  const outIdx = args.indexOf("--out");
  const outFile = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const cmpIdx = args.indexOf("--compare");
  const compareWith = cmpIdx >= 0 ? args[cmpIdx + 1] : undefined;

  const report = await runScenarios();

  const rendered = wantJson ? toJSON(report) : wantMd ? toMarkdown(report) : toConsole(report);
  if (outFile) {
    writeFileSync(outFile, wantMd ? toMarkdown(report) : toJSON(report), "utf-8");
    process.stdout.write(toConsole(report));
    process.stdout.write(`\n  report → ${outFile}\n`);
  } else {
    process.stdout.write(rendered + "\n");
  }

  // E9: against a baseline, when one was given.
  //
  // A pass rate on its own does not say whether anything got worse. Two runs in two
  // terminals that nobody diffed is how a governance scenario goes red across a model
  // change and stays red: both runs looked like a number somebody glanced at.
  //
  // A regression fails the run even when every remaining scenario passes, because
  // "still 94%" and "the clamp scenario stopped holding" are not the same news.
  let regressed = false;
  if (compareWith) {
    try {
      const baseline = JSON.parse(readFileSync(compareWith, "utf-8")) as EvalReport;
      const outcome = compareReports(baseline, report, { baseline: compareWith, current: "this run" });
      process.stdout.write("\n" + outcome.text + "\n");
      regressed = outcome.blocking;
    } catch (error) {
      // Reported and fatal. A comparison that silently did not happen is worse than
      // none: the pipeline goes green having checked nothing, under a flag that says
      // it checked.
      process.stderr.write(`\n  could not compare against ${compareWith}: ${(error as Error).message}\n`);
      process.exit(2);
    }
  }

  process.exit(report.failed === 0 && !regressed ? 0 : 1);
}

import { pathToFileURL } from "node:url";
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().catch((err) => {
    console.error("personaxis-evals fatal:", err);
    process.exit(1);
  });
}
