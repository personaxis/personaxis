export type Severity = "error" | "warning" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  path?: string;
  message: string;
}

export interface LintSummary {
  errors: number;
  warnings: number;
  infos: number;
}

export interface LintReport {
  findings: Finding[];
  summary: LintSummary;
  layerCount: number;
  missingLayers: string[];
}
