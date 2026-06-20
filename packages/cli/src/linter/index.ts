import matter from "gray-matter";
import { runRules } from "./rules.js";
import type { Finding, LintReport, LintSummary } from "./types.js";

export type { Finding, LintReport, LintSummary };
export { type Severity } from "./types.js";

function summarize(findings: Finding[]): LintSummary {
  return {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    infos: findings.filter((f) => f.severity === "info").length,
  };
}

export function lint(markdownString: string): LintReport {
  let data: Record<string, unknown>;

  try {
    const parsed = matter(markdownString);
    data = parsed.data as Record<string, unknown>;
  } catch {
    return {
      findings: [
        {
          rule: "parse-error",
          severity: "error",
          message: "Failed to parse YAML frontmatter. Ensure the file starts with --- and contains valid YAML.",
        },
      ],
      summary: { errors: 1, warnings: 0, infos: 0 },
      layerCount: 0,
      missingLayers: [],
    };
  }

  const { findings, presentLayers, missingLayers } = runRules(data);
  const summary = summarize(findings);

  return {
    findings,
    summary,
    layerCount: presentLayers.length,
    missingLayers,
  };
}
