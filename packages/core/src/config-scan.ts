/**
 * Agent-config security scanner (v0.9, the "Shield" wedge).
 *
 * AI-agent config files (CLAUDE.md, AGENTS.md, .cursorrules, .codex/*.toml,
 * agents.json, personaxis.md) are an unattended attack surface: prompt injection
 * hidden in instructions/skill descriptions, over-broad permissions, and leaked
 * credentials. (AgentShield reports 520 of 17,022 audited skills leak creds.) This
 * scanner audits any of those, cross-harness, in three passes, red-team (find the
 * attack), blue-team (check the boundaries), auditor (leaks + structured report), 
 * reusing the engine's injection scanner. Pure + dependency-free; CLI exit codes.
 */

import matter from "gray-matter";
import { scanForInjection } from "./injection.js";

export type ConfigKind =
  | "personaxis" | "persona-md" | "claude-md" | "agents-md" | "cursorrules" | "codex-toml" | "agents-json" | "unknown";

export type ScanTeam = "red" | "blue" | "auditor";
export type ScanSeverity = "error" | "warning" | "info";

export interface ScanFinding {
  rule: string;
  severity: ScanSeverity;
  team: ScanTeam;
  message: string;
  match?: string;
}

export type ScanVerdict = "clean" | "suspicious" | "risky" | "malicious";

export interface ConfigScanResult {
  kind: ConfigKind;
  verdict: ScanVerdict;
  score: number;
  findings: ScanFinding[];
}

export function detectKind(nameOrPath: string): ConfigKind {
  const n = nameOrPath.toLowerCase().replace(/\\/g, "/");
  if (n.endsWith("personaxis.md")) return "personaxis";
  if (n.endsWith("persona.md") || /\.claude\/agents\/.*\.md$/.test(n)) return "persona-md";
  if (n.endsWith("claude.md")) return "claude-md";
  if (n.endsWith("agents.md")) return "agents-md";
  if (n.endsWith(".cursorrules") || n.endsWith("persona.mdc")) return "cursorrules";
  if (n.endsWith(".toml") && n.includes("agents")) return "codex-toml";
  if (n.endsWith("agents.json")) return "agents-json";
  return "unknown";
}

// ── Credential leak patterns (auditor) ───────────────────────────────────────
const SECRET_PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: "secret:openai-key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { rule: "secret:aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: "secret:google-key", re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { rule: "secret:github-token", re: /\bgh[posru]_[A-Za-z0-9]{30,}\b/g },
  { rule: "secret:slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: "secret:bearer", re: /\bBearer\s+[A-Za-z0-9._\-]{16,}/g },
  { rule: "secret:private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { rule: "secret:assignment", re: /\b(?:api[_-]?key|secret|password|access[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}/gi },
];

// ── Dangerous-permission tokens (blue-team) ──────────────────────────────────
const DANGER_TOKENS: Array<{ rule: string; re: RegExp; message: string }> = [
  { rule: "perm:full-access", re: /danger-full-access|"?bypassPermissions"?|dangerously[-_]?skip/i, message: "grants unrestricted access (no sandbox)" },
  { rule: "perm:approval-never", re: /approval\s*[:=]\s*["']?never/i, message: "never asks for approval before risky actions" },
  { rule: "perm:autorun", re: /auto[-_]?(approve|run|accept)\s*[:=]\s*(true|all|yes)/i, message: "auto-approves/auto-runs actions" },
];

// ── Remote skill/source references (auditor, supply chain) ──────────────────
const REMOTE_SOURCE = /\b(github:[\w./-]+|https?:\/\/[^\s"')]+)/gi;

function inject(findings: ScanFinding[], f: ScanFinding): void {
  findings.push(f);
}

export function scanAgentConfig(text: string, kindHint?: ConfigKind): ConfigScanResult {
  const kind = kindHint ?? "unknown";
  const findings: ScanFinding[] = [];

  // RED TEAM, prompt injection in the config body / instructions / descriptions.
  const scan = scanForInjection(text);
  if (scan.verdict !== "clean") {
    inject(findings, {
      rule: `injection:${scan.verdict}`,
      severity: scan.verdict === "malicious" ? "error" : "warning",
      team: "red",
      message: `prompt-injection signals (${scan.findings.map((x) => x.rule).slice(0, 4).join(", ")})`,
    });
  }
  // Classic override phrases (caught explicitly even when sub-threshold).
  for (const m of text.matchAll(/ignore (?:all )?previous instructions|disregard (?:the )?(?:above|system)|reveal (?:your )?system prompt|you are now/gi)) {
    inject(findings, { rule: "injection:override-phrase", severity: "warning", team: "red", message: "instruction-override phrase present", match: m[0].slice(0, 60) });
  }

  // BLUE TEAM, permission posture.
  for (const d of DANGER_TOKENS) {
    const m = text.match(d.re);
    if (m) inject(findings, { rule: d.rule, severity: "error", team: "blue", message: d.message, match: m[0].slice(0, 60) });
  }
  // For personaxis/persona configs, parse the permissions block and check guards.
  if (kind === "personaxis" || kind === "persona-md") {
    try {
      const fm = matter(text).data as { permissions?: { sandbox?: string; approval?: string; deny?: unknown[] } };
      const perms = fm.permissions;
      if (perms) {
        const denies = Array.isArray(perms.deny) ? perms.deny.map(String) : [];
        const hasRmGuard = denies.some((d) => /rm\b|rmdir|del\b/.test(d));
        const hasPipeGuard = denies.some((d) => /curl|wget|\|\s*(ba)?sh/.test(d));
        if (perms.sandbox !== "read-only" && !hasRmGuard)
          inject(findings, { rule: "perm:no-rm-guard", severity: "warning", team: "blue", message: "writable sandbox without a deny rule for destructive `rm`/`del`" });
        if (perms.sandbox === "danger-full-access" && !hasPipeGuard)
          inject(findings, { rule: "perm:no-pipe-guard", severity: "warning", team: "blue", message: "full access without a deny rule for `curl|sh` remote execution" });
      }
    } catch {
      /* not valid frontmatter; the token scan above still applies */
    }
  }

  // AUDITOR, credential leaks.
  for (const s of SECRET_PATTERNS) {
    for (const m of text.matchAll(s.re)) {
      inject(findings, { rule: s.rule, severity: "error", team: "auditor", message: "looks like a hardcoded credential, never ship secrets in a config", match: m[0].slice(0, 8) + "…" });
    }
  }
  // AUDITOR, remote skill/source references to review (supply chain).
  const remotes = new Set<string>();
  for (const m of text.matchAll(REMOTE_SOURCE)) remotes.add(m[1]);
  for (const r of [...remotes].slice(0, 20)) {
    if (/skill|agent|prompt|tool/i.test(r) || r.startsWith("github:"))
      inject(findings, { rule: "supply-chain:remote-source", severity: "info", team: "auditor", message: "external source, audit before trusting", match: r.slice(0, 60) });
  }

  // Score + verdict.
  const weight = (s: ScanSeverity) => (s === "error" ? 1 : s === "warning" ? 0.4 : 0.1);
  const score = Number(findings.reduce((a, f) => a + weight(f.severity), 0).toFixed(2));
  const hasLeakOrMalicious = findings.some(
    (f) => f.team === "auditor" && f.severity === "error") || findings.some((f) => f.rule === "injection:malicious");
  const hasError = findings.some((f) => f.severity === "error");
  const hasWarn = findings.some((f) => f.severity === "warning");
  const verdict: ScanVerdict = hasLeakOrMalicious ? "malicious" : hasError ? "risky" : hasWarn ? "suspicious" : "clean";

  return { kind, verdict, score, findings };
}
