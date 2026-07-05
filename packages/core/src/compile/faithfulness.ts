/**
 * F3.1 — the DETERMINISTIC faithfulness check (guards stage 2 of the pipeline).
 *
 * Stage 2 (the optional LLM "polish") is constrained to REPHRASE the assembled
 * document, never to ADD or DROP claims. This check enforces that contract
 * deterministically by diffing the polished document against the assembled one
 * (the ground truth), section by section, over the PROTECTED claim classes:
 *
 *   - Hard limits          — a dropped safety limit is a hard failure.
 *   - Staying in character  — same (these are hard limits too).
 *   - What you always/never — behavioral anchors.
 *   - What is fixed/change   — consistency dimensions.
 *
 * The historical CMO regression — the compiled PERSONA.md invented `consistency`
 * items the source never declared — fails here as an INVENTED finding.
 *
 * Matching is token-coverage based (deterministic, no model): a claim is
 * "preserved" iff some claim on the other side shares enough content tokens.
 * Rephrasing (synonym-free reordering, added connective words) passes; adding a
 * genuinely new bullet or dropping one does not.
 */

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "in", "into", "is", "it",
  "its", "of", "on", "or", "that", "the", "their", "them", "then", "they", "this", "to", "you",
  "your", "with", "when", "what", "which", "who", "will", "not", "no", "do", "does", "done", "any",
  "every", "each", "must", "may", "can", "cannot", "never", "always", "always:", "never:",
]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[`*_#>[\]()"'.,;:!?]/g, " ")
      .split(/\s+/)
      .map((t) => t.replace(/s$/, "")) // crude singularize so plural rephrasing still matches
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/** Content-token coverage of `a` by `b`: |a∩b| / |a|. */
function coverage(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 1;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / a.size;
}

/** Extract the bullet claims under each protected `## section` heading. */
function claimsBySection(doc: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const lines = doc.split(/\r?\n/);
  let current: string | undefined;
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      current = h[1].trim().toLowerCase();
      map.set(current, []);
      continue;
    }
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b && current) {
      const text = b[1].replace(/^\*\*[^*]+\*\*:?\s*/, "").trim(); // drop a leading **bold:** label
      if (text) map.get(current)!.push(text);
    }
  }
  return map;
}

export type FaithfulnessSection =
  | "hard limits (never overridden)"
  | "staying in character"
  | "what you always / never do"
  | "what is fixed, what can change";

export interface FaithfulnessFinding {
  kind: "dropped" | "invented";
  section: string;
  /** The claim text that was dropped from the source or invented in the polish. */
  text: string;
  /** Best token-coverage found against the other side (for diagnostics). */
  bestCoverage: number;
}

export interface FaithfulnessReport {
  ok: boolean;
  findings: FaithfulnessFinding[];
}

export interface FaithfulnessOptions {
  /** A claim is preserved when coverage ≥ this. Default 0.5. */
  threshold?: number;
  /** Sections checked. Default: the four protected classes. */
  sections?: string[];
}

const DEFAULT_SECTIONS = [
  "hard limits (never overridden)",
  "staying in character",
  "what you always / never do",
  "what is fixed, what can change",
];

/**
 * Diff `polished` against `assembled` (the ground truth). Returns findings for
 * dropped source claims and invented polish claims in the protected sections.
 */
export function checkFaithfulness(
  assembled: string,
  polished: string,
  opts: FaithfulnessOptions = {},
): FaithfulnessReport {
  const threshold = opts.threshold ?? 0.5;
  const sections = opts.sections ?? DEFAULT_SECTIONS;
  const src = claimsBySection(assembled);
  const out = claimsBySection(polished);
  const findings: FaithfulnessFinding[] = [];

  for (const section of sections) {
    const srcClaims = (src.get(section) ?? []).map((t) => ({ text: t, tok: tokens(t) }));
    const outClaims = (out.get(section) ?? []).map((t) => ({ text: t, tok: tokens(t) }));

    // Dropped: a source claim with no sufficiently-covering polish claim.
    for (const s of srcClaims) {
      let best = 0;
      for (const o of outClaims) best = Math.max(best, coverage(s.tok, o.tok));
      if (best < threshold) findings.push({ kind: "dropped", section, text: s.text, bestCoverage: best });
    }
    // Invented: a polish claim with no sufficiently-covering source claim.
    for (const o of outClaims) {
      let best = 0;
      for (const s of srcClaims) best = Math.max(best, coverage(o.tok, s.tok));
      if (best < threshold) findings.push({ kind: "invented", section, text: o.text, bestCoverage: best });
    }
  }

  return { ok: findings.length === 0, findings };
}

/** One-line human summary of a report (for CLI output / logs). */
export function summarizeFaithfulness(report: FaithfulnessReport): string {
  if (report.ok) return "faithfulness: OK (polish preserved every protected claim)";
  const dropped = report.findings.filter((f) => f.kind === "dropped").length;
  const invented = report.findings.filter((f) => f.kind === "invented").length;
  return `faithfulness: FAIL — ${dropped} dropped, ${invented} invented protected claim(s)`;
}
