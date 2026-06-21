/**
 * Prompt-injection scanning (F3 / T7 — plan/11-security).
 *
 * Untrusted text — tool outputs, fetched content, project files like AGENTS.md /
 * CLAUDE.md — is scanned BEFORE it influences the persona (Hermes scans context
 * files before loading them). Memory-poisoning defenses don't cover injection and
 * vice-versa (Dash et al., 2026), so both run. Detected injections are surfaced as
 * anomalies and block mutation on that turn; the content can still be remembered,
 * tagged, for audit.
 */

export type InjectionSeverity = "info" | "suspicious" | "malicious";

export interface InjectionFinding {
  rule: string;
  severity: InjectionSeverity;
  match: string;
}

export interface InjectionScan {
  verdict: "clean" | "suspicious" | "malicious";
  findings: InjectionFinding[];
}

interface Rule {
  re: RegExp;
  severity: InjectionSeverity;
  rule: string;
}

const RULES: Rule[] = [
  { re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts?)/i, severity: "malicious", rule: "ignore-previous" },
  { re: /disregard\s+(the\s+)?(system|previous|above)/i, severity: "malicious", rule: "disregard-system" },
  { re: /you\s+are\s+now\s+(a|an|the)\b/i, severity: "suspicious", rule: "role-override" },
  { re: /(reveal|print|show|repeat)\s+(your|the)\s+(system\s+prompt|instructions|persona|secrets?)/i, severity: "malicious", rule: "prompt-exfil" },
  { re: /\bBEGIN\s+SYSTEM\b|<\s*system\s*>/i, severity: "suspicious", rule: "fake-system-block" },
  { re: /(send|post|exfiltrate|upload)\s+.{0,30}\b(to|at)\b\s+https?:\/\//i, severity: "malicious", rule: "exfil-network" },
  { re: /override\s+(your\s+)?(safety|guardrails?|governance|constraints?)/i, severity: "malicious", rule: "override-safety" },
  { re: /from\s+now\s+on,?\s+(you|always|never)\b/i, severity: "suspicious", rule: "persistent-instruction" },
  { re: /developer\s+mode|jailbreak|DAN\b/i, severity: "suspicious", rule: "jailbreak-keyword" },
];

export function scanForInjection(text: string): InjectionScan {
  const findings: InjectionFinding[] = [];
  for (const r of RULES) {
    const m = text.match(r.re);
    if (m) findings.push({ rule: r.rule, severity: r.severity, match: m[0].slice(0, 80) });
  }
  const verdict = findings.some((f) => f.severity === "malicious")
    ? "malicious"
    : findings.some((f) => f.severity === "suspicious")
      ? "suspicious"
      : "clean";
  return { verdict, findings };
}
