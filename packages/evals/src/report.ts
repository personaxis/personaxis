import type { EvalReport } from "./types.js";

export function toJSON(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

export function toMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`## Personaxis governance evals`);
  lines.push("");
  lines.push(`**${report.passed}/${report.total} scenarios passed** · acceptance ${(report.passRate * 100).toFixed(0)}%`);
  lines.push("");
  lines.push("| Category | Passed |");
  lines.push("|---|---|");
  for (const [cat, c] of Object.entries(report.byCategory)) lines.push(`| ${cat} | ${c.passed}/${c.total} |`);
  lines.push("");
  lines.push("| Scenario | Result | Checks |");
  lines.push("|---|---|---|");
  for (const r of report.results) {
    const checks = r.checks.map((c) => `${c.pass ? "✓" : "✗"} ${c.name}`).join("<br>");
    lines.push(`| \`${r.id}\` | ${r.passed ? "✅ pass" : "❌ FAIL"} | ${checks} |`);
  }
  return lines.join("\n");
}

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export function toConsole(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(C.bold(`  Personaxis governance evals — ${report.passed}/${report.total} passed (${(report.passRate * 100).toFixed(0)}%)`));
  lines.push("");
  for (const r of report.results) {
    lines.push(`  ${r.passed ? C.green("✓") : C.red("✗")} ${r.id.padEnd(36)} ${C.dim(r.category)}`);
    for (const c of r.checks) {
      if (!c.pass) lines.push(`      ${C.red("✗")} ${c.name}: ${C.dim(c.detail)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
