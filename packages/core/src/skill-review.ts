/**
 * Skill security review (F6 — plan/06-skills).
 *
 * We don't maintain skills; we USE them from external sources (Anthropic, GitHub,
 * ClawHub). But ~26% of community skills carry vulnerabilities (Xu & Yan, 2026)
 * and the ClawHavoc campaign shipped 1,200+ malicious skills. So every skill is
 * scanned BEFORE use: risky shell/network/eval/secret patterns are flagged, a
 * verdict is produced, and a content hash is returned for allowlisting. Never
 * auto-update; pin by hash.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export type Severity = "info" | "warn" | "danger";

export interface SkillFinding {
  severity: Severity;
  rule: string;
  file: string;
  match: string;
}

export interface SkillReview {
  skillPath: string;
  files: string[];
  hash: string;
  findings: SkillFinding[];
  verdict: "ok" | "review" | "danger";
}

interface Rule {
  re: RegExp;
  severity: Severity;
  rule: string;
}

const RULES: Rule[] = [
  { re: /\brm\s+-rf\b/, severity: "danger", rule: "destructive-rm" },
  { re: /curl[^\n|]*\|\s*(ba)?sh/i, severity: "danger", rule: "curl-pipe-shell" },
  { re: /wget[^\n|]*\|\s*(ba)?sh/i, severity: "danger", rule: "wget-pipe-shell" },
  { re: /base64\s+-+d/i, severity: "danger", rule: "base64-decode-exec" },
  { re: /\beval\s*\(/, severity: "danger", rule: "eval" },
  { re: /child_process|subprocess\.|os\.system|exec\(/i, severity: "warn", rule: "process-spawn" },
  { re: /process\.env\.|os\.environ|\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)/, severity: "warn", rule: "secret-access" },
  { re: /\bsudo\b/, severity: "warn", rule: "privilege-escalation" },
  { re: /https?:\/\/(?!github\.com|raw\.githubusercontent\.com|anthropic\.com)[^\s'")]+/i, severity: "info", rule: "external-network" },
  { re: /~\/\.ssh|id_rsa|\.aws\/credentials|\.npmrc/, severity: "danger", rule: "credential-file-access" },
];

const SCANNABLE = new Set([".md", ".sh", ".bash", ".py", ".js", ".ts", ".mjs", ".cjs", ".yaml", ".yml", ".json"]);

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (SCANNABLE.has(extname(name))) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export function reviewSkill(skillPath: string): SkillReview {
  if (!existsSync(skillPath)) {
    throw new Error(`skill path not found: ${skillPath}`);
  }
  const isDir = statSync(skillPath).isDirectory();
  const files = isDir ? collectFiles(skillPath) : [skillPath];

  const findings: SkillFinding[] = [];
  const hasher = createHash("sha256");

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    hasher.update(file).update(content);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const r of RULES) {
        const m = lines[i].match(r.re);
        if (m) {
          findings.push({ severity: r.severity, rule: r.rule, file, match: m[0].slice(0, 80) });
        }
      }
    }
  }

  const hasDanger = findings.some((f) => f.severity === "danger");
  const hasWarn = findings.some((f) => f.severity === "warn");
  const verdict: SkillReview["verdict"] = hasDanger ? "danger" : hasWarn ? "review" : "ok";

  return { skillPath, files, hash: hasher.digest("hex"), findings, verdict };
}
