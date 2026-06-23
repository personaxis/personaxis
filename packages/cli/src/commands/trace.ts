/**
 * `personaxis trace <file>` — render a native JSONL trace as a causal timeline.
 *
 * The companion to `observability.trace`: when the governed loop writes a trace,
 * this turns it into a readable, color-coded sequence (observe → appraise → govern
 * → mutate → tool-propose → tool-verdict → tool-result → verify → finish), with
 * timing, so you can see exactly what the agent did and why — the audit made legible.
 */

import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { parseTraceJSONL, type TraceSpan } from "@personaxis/core";

const COLOR: Record<string, (s: string) => string> = {
  observe: chalk.blue,
  appraise: chalk.cyan,
  govern: chalk.magenta,
  mutate: chalk.green,
  memory: chalk.green,
  anomaly: chalk.red,
  abstain: chalk.dim,
  error: chalk.red,
  "agent-step": chalk.dim,
  "tool-propose": chalk.cyan,
  "tool-verdict": chalk.yellow,
  "tool-result": chalk.green,
  "agent-stop-condition": chalk.yellow,
  "verify-result": chalk.yellow,
  "verify-complete": chalk.bold,
  "agent-finish": chalk.green,
  "agent-error": chalk.red,
};

function summarize(s: TraceSpan): string {
  const d = s.data;
  switch (s.type) {
    case "observe": return String(d.observation ?? "").slice(0, 80);
    case "tool-propose": return `${d.tool} ${JSON.stringify(d.args).slice(0, 70)}`;
    case "tool-verdict": return `${d.tool}: ${d.decision} (${d.reason})`;
    case "tool-result": return `${d.tool}: ${d.ok ? "ok" : "fail"} ${String(d.output ?? "").split("\n")[0].slice(0, 60)}`;
    case "mutate": return JSON.stringify(d.result).slice(0, 80);
    case "verify-result": return `${d.verifier}: ${d.pass ? "pass" : "fail"} ${d.reason}`;
    case "verify-complete": return `${d.passed ? "verified" : "FAILED"} (${d.passes}/${d.quorum})`;
    case "agent-stop-condition": return `stop: ${d.reason}`;
    case "agent-finish": return String(d.summary ?? "").slice(0, 80);
    case "agent-error":
    case "error": return String(d.message ?? "");
    default: return Object.keys(d).length ? JSON.stringify(d).slice(0, 80) : "";
  }
}

export const traceCommand = new Command("trace")
  .description("Render a native JSONL causal trace (from observability.trace) as a timeline.")
  .argument("<file>", "Path to a trace-*.jsonl file")
  .option("--json", "Print the parsed spans as JSON")
  .action((file: string, opts: { json?: boolean }) => {
    const path = resolve(file);
    if (!existsSync(path)) {
      console.error(chalk.red("Error:"), `trace not found at ${path}`);
      process.exit(1);
    }
    const spans = parseTraceJSONL(readFileSync(path, "utf-8"));
    if (opts.json) {
      console.log(JSON.stringify(spans, null, 2));
      return;
    }
    console.log(chalk.bold(`\n  Trace · ${spans.length} spans · ${path}\n`));
    for (const s of spans) {
      const color = COLOR[s.type] ?? chalk.white;
      const t = `+${(s.t_ms / 1000).toFixed(2)}s`.padStart(8);
      console.log(`  ${chalk.dim(t)}  ${color(s.type.padEnd(20))} ${chalk.dim(summarize(s))}`);
    }
    console.log("");
  });
