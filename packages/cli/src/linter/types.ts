export type Severity = "error" | "warning" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  path?: string;
  message: string;
  /**
   * The edit that resolves the finding, in the imperative. REQUIRED: the type
   * system is what keeps a new rule from shipping a warning the reader has to
   * decode. `message` says what is wrong, `fix` says what to change.
   */
  fix: string;
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
