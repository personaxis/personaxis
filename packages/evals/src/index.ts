#!/usr/bin/env node
/**
 * `personaxis-evals` — run the governance/property eval suite.
 *
 * Deterministic by default (no API key): exercises the real engine and asserts the
 * invariants that make Personaxis "governed". A regression (e.g. breaking the clamp)
 * fails the suite. Designed to gate CI and to be the evidence behind the moat.
 *
 *   personaxis-evals [--json] [--markdown] [--out <file>]
 */

import { writeFileSync } from "node:fs";
import { runScenarios } from "./runner.js";
import { toConsole, toJSON, toMarkdown } from "./report.js";

export { runScenarios } from "./runner.js";
export { SCENARIOS } from "./scenarios.js";
export * from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const wantMd = args.includes("--markdown");
  const outIdx = args.indexOf("--out");
  const outFile = outIdx >= 0 ? args[outIdx + 1] : undefined;

  const report = await runScenarios();

  const rendered = wantJson ? toJSON(report) : wantMd ? toMarkdown(report) : toConsole(report);
  if (outFile) {
    writeFileSync(outFile, wantMd ? toMarkdown(report) : toJSON(report), "utf-8");
    process.stdout.write(toConsole(report));
    process.stdout.write(`\n  report → ${outFile}\n`);
  } else {
    process.stdout.write(rendered + "\n");
  }

  process.exit(report.failed === 0 ? 0 : 1);
}

import { pathToFileURL } from "node:url";
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().catch((err) => {
    console.error("personaxis-evals fatal:", err);
    process.exit(1);
  });
}
