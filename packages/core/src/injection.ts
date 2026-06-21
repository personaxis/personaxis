/**
 * Prompt-injection detection (F3 / T7 — plan/11-security).
 *
 * A layered, evasion-aware first line of defense over untrusted text (tool output,
 * fetched content, project files, observations). Heuristic guardrails are exactly
 * what production systems run *before* a model-based classifier; this engine is
 * built to be that first line and to hand off to a model classifier when present.
 *
 * Layers:
 *   1. Normalization — NFKC, strip/flag zero-width + bidi-override chars, fold a
 *      homoglyph (confusables) map. Adversaries obfuscate; we de-obfuscate first.
 *   2. Decoding — base64 / hex blocks are decoded and recursively scanned, so an
 *      "ignore previous instructions" hidden inside base64 is still caught.
 *   3. Weighted rules across categories (instruction-override, exfiltration,
 *      role-manipulation, tool-abuse, jailbreak, obfuscation, encoding-evasion).
 *   4. Score aggregation -> clean | suspicious | malicious, with a confidence.
 *
 * Pluggable: pass a `classifier` to layer a model-based judgment on top.
 */

export type InjectionSeverity = "info" | "suspicious" | "malicious";
export type InjectionCategory =
  | "instruction-override"
  | "exfiltration"
  | "role-manipulation"
  | "tool-abuse"
  | "jailbreak"
  | "obfuscation"
  | "encoding-evasion";

export interface InjectionFinding {
  rule: string;
  category: InjectionCategory;
  severity: InjectionSeverity;
  weight: number;
  match: string;
}

export interface InjectionScan {
  verdict: "clean" | "suspicious" | "malicious";
  /** Aggregate risk score (0..1+). */
  score: number;
  findings: InjectionFinding[];
  /** Text after normalization (de-obfuscation) — what the rules actually saw. */
  normalized: string;
  /** Decoded base64/hex segments that were also scanned. */
  decoded: string[];
}

export interface InjectionConfig {
  suspiciousAt: number;
  maliciousAt: number;
  /** Optional model-based classifier; its score is fused with the heuristic. */
  classifier?: (normalized: string) => { score: number; label?: string };
}

const DEFAULT_CONFIG: InjectionConfig = { suspiciousAt: 0.4, maliciousAt: 0.9 };

interface Rule {
  re: RegExp;
  category: InjectionCategory;
  severity: InjectionSeverity;
  weight: number;
  rule: string;
}

const RULES: Rule[] = [
  { re: /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|messages?|context)/i, category: "instruction-override", severity: "malicious", weight: 1.0, rule: "ignore-previous" },
  { re: /disregard\s+(the\s+|all\s+|any\s+)?(system|previous|above|prior|earlier)/i, category: "instruction-override", severity: "malicious", weight: 1.0, rule: "disregard" },
  { re: /forget\s+(everything|all|your\s+(instructions|rules|guidelines))/i, category: "instruction-override", severity: "malicious", weight: 0.9, rule: "forget-everything" },
  { re: /(reveal|print|show|repeat|output|leak)\s+(me\s+)?(your|the)\s+(system\s*prompt|instructions|persona|secret|hidden\s+(rules|prompt))/i, category: "exfiltration", severity: "malicious", weight: 1.0, rule: "prompt-exfil" },
  { re: /(send|post|exfiltrate|upload|transmit|email)\s+.{0,40}\b(to|at|toward)\b\s*(https?:\/\/|[\w.-]+@)/i, category: "exfiltration", severity: "malicious", weight: 1.0, rule: "exfil-destination" },
  { re: /override\s+(your\s+)?(safety|guardrails?|governance|constraints?|filters?|policy)/i, category: "instruction-override", severity: "malicious", weight: 1.0, rule: "override-safety" },
  { re: /\bBEGIN\s+SYSTEM\b|<\s*\/?\s*system\s*>|\[\s*system\s*\]/i, category: "role-manipulation", severity: "suspicious", weight: 0.6, rule: "fake-system-block" },
  { re: /you\s+are\s+now\s+(a|an|the|in)\b|act\s+as\s+(if\s+you\s+are\s+)?(a|an|the)\b/i, category: "role-manipulation", severity: "suspicious", weight: 0.5, rule: "role-override" },
  { re: /from\s+now\s+on,?\s+(you|always|never|respond|answer|act)\b/i, category: "role-manipulation", severity: "suspicious", weight: 0.5, rule: "persistent-instruction" },
  { re: /\b(developer\s+mode|jailbreak|DAN\b|do\s+anything\s+now|unfiltered|no\s+restrictions?)\b/i, category: "jailbreak", severity: "suspicious", weight: 0.6, rule: "jailbreak-keyword" },
  { re: /(call|invoke|run|execute)\s+(the\s+)?(tool|function|command|shell|bash)\b.{0,40}(delete|rm\b|curl|wget|exfil|secret|cred)/i, category: "tool-abuse", severity: "malicious", weight: 0.9, rule: "tool-abuse" },
];

// A compact confusables map (Cyrillic/Greek lookalikes -> Latin) for homoglyph folding.
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i",
  "Ι": "I", "Ο": "O", "А": "A", "Е": "E", "О": "O", "Р": "P", "С": "C",
  "ο": "o", "α": "a", "ε": "e", "ρ": "p", "υ": "u",
};

const ZERO_WIDTH = new RegExp("[" + [0x200B,0x200C,0x200D,0x2060,0xFEFF].map((c) => String.fromCharCode(c)).join("") + "]", "g");
const BIDI_OVERRIDE = new RegExp("[" + [0x202A,0x202B,0x202C,0x202D,0x202E,0x2066,0x2067,0x2068,0x2069].map((c) => String.fromCharCode(c)).join("") + "]", "g");

function normalize(text: string): { normalized: string; obfuscations: InjectionFinding[] } {
  const obfuscations: InjectionFinding[] = [];
  let t = text.normalize("NFKC");

  // Use replace-and-compare (not .test) — a /g regex with .test() is stateful and
  // would yield false negatives when the singleton regex is reused across scans.
  const noZw = t.replace(ZERO_WIDTH, "");
  if (noZw !== t) {
    obfuscations.push({ rule: "zero-width-chars", category: "obfuscation", severity: "suspicious", weight: 0.4, match: "<zero-width>" });
    t = noZw;
  }
  const noBidi = t.replace(BIDI_OVERRIDE, "");
  if (noBidi !== t) {
    obfuscations.push({ rule: "bidi-override", category: "obfuscation", severity: "suspicious", weight: 0.4, match: "<bidi-override>" });
    t = noBidi;
  }
  let folded = "";
  let homoglyphHit = false;
  for (const ch of t) {
    const sub = CONFUSABLES[ch];
    if (sub) {
      homoglyphHit = true;
      folded += sub;
    } else folded += ch;
  }
  if (homoglyphHit) {
    obfuscations.push({ rule: "homoglyph", category: "obfuscation", severity: "suspicious", weight: 0.4, match: "<confusable-chars>" });
  }
  return { normalized: folded, obfuscations };
}

function decodeSegments(text: string): string[] {
  const out: string[] = [];
  // base64 runs (length-aware to avoid plain words)
  for (const m of text.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)) {
    try {
      const decoded = Buffer.from(m[0], "base64").toString("utf8");
      if (decoded && /[\x20-\x7e]/.test(decoded) && printableRatio(decoded) > 0.8) out.push(decoded);
    } catch {
      /* ignore */
    }
  }
  // hex runs
  for (const m of text.matchAll(/(?:[0-9a-fA-F]{2}){8,}/g)) {
    try {
      const decoded = Buffer.from(m[0], "hex").toString("utf8");
      if (decoded && printableRatio(decoded) > 0.8) out.push(decoded);
    } catch {
      /* ignore */
    }
  }
  return out;
}

function printableRatio(s: string): number {
  if (!s.length) return 0;
  let p = 0;
  for (const c of s) if (c >= " " && c <= "~") p++;
  return p / s.length;
}

function applyRules(text: string, decodedOrigin = false): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const r of RULES) {
    const m = text.match(r.re);
    if (m) {
      findings.push({
        rule: decodedOrigin ? `encoded:${r.rule}` : r.rule,
        category: decodedOrigin ? "encoding-evasion" : r.category,
        severity: r.severity,
        weight: decodedOrigin ? Math.min(1, r.weight + 0.2) : r.weight,
        match: m[0].slice(0, 80),
      });
    }
  }
  return findings;
}

export function scanForInjection(text: string, config: Partial<InjectionConfig> = {}): InjectionScan {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { normalized, obfuscations } = normalize(text);

  const findings: InjectionFinding[] = [...obfuscations, ...applyRules(normalized)];

  const decoded = decodeSegments(normalized);
  for (const d of decoded) findings.push(...applyRules(d, true));

  let score = findings.reduce((s, f) => s + f.weight, 0);

  if (cfg.classifier) {
    const c = cfg.classifier(normalized);
    score = Math.max(score, c.score); // fuse: take the stronger signal
    if (c.score >= cfg.suspiciousAt) {
      findings.push({ rule: `classifier:${c.label ?? "flagged"}`, category: "instruction-override", severity: c.score >= cfg.maliciousAt ? "malicious" : "suspicious", weight: c.score, match: "<model>" });
    }
  }

  const verdict = score >= cfg.maliciousAt ? "malicious" : score >= cfg.suspiciousAt ? "suspicious" : "clean";
  return { verdict, score: Number(score.toFixed(3)), findings, normalized, decoded };
}
