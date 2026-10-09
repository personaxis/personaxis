/**
 * F3.1, the DETERMINISTIC faithfulness check on the compiled document.
 *
 * A model writes PERSONA.md (since 2026-10-07; before, it only polished an assembly). It may write
 * freely, but it may not ADD or DROP a protected claim. This check enforces that by diffing the
 * written document against the reference the code assembles from the spec (the ground truth),
 * section by section, over the PROTECTED claim classes:
 *
 *   - Hard limits, a dropped safety limit is a hard failure.
 *   - Staying in character, same (these are hard limits too).
 *   - What you always/never, behavioral anchors.
 *   - What is fixed/change, consistency dimensions.
 *   - Memory & resources, the paths to the persona's memory, skills and references (E92: a document
 *     that lost them left the persona unable to see what it had). Since 2026-10-07 the model WRITES the
 *     document, so nothing but this check keeps those lines.
 *
 * The historical CMO regression, the compiled PERSONA.md invented `consistency`
 * items the source never declared, fails here as an INVENTED finding.
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
    // `\S` first, so the whitespace run and the text cannot both claim the same tabs (polynomial backtracking).
    const h = line.match(/^##\s+(\S.*)$/);
    if (h) {
      current = h[1].trim().toLowerCase();
      map.set(current, []);
      continue;
    }
    const b = line.match(/^\s*[-*]\s+(\S.*)$/);
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
  | "what is fixed, what can change"
  | "memory & resources";

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
  "memory & resources",
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

  // A section the assembled document does not have is invented whole. Measured 2026-10-07: a polish ended
  // with the heading of its own prompt's reference block and the source file's Overview, and passed,
  // because the claims above are compared inside the protected sections only.
  const heading = (h: string): string => h.toLowerCase().replace(/\s+/g, " ").trim();
  // Line by line, without a regex: CodeQL flagged /^##\s+(.+?)\s*$/ as polynomial on tab-heavy input.
  const headingsOf = (doc: string): string[] =>
    doc
      .split("\n")
      .filter((line) => line.startsWith("##") && !line.startsWith("###"))
      .map((line) => line.slice(2).trim())
      .filter((h) => h.length > 0);
  const known = new Set(headingsOf(assembled).map(heading));
  for (const h of headingsOf(polished)) {
    if (!known.has(heading(h))) findings.push({ kind: "invented", section: "(sections)", text: h, bestCoverage: 0 });
  }

  return { ok: findings.length === 0, findings };
}

/**
 * Put a written document back in line with the reference on the protected claims alone: every dropped
 * bullet goes back verbatim into its section (under the same **Always:** or **Never:** label when the
 * reference has one), every invented bullet in a protected section is taken out. Everything else, the
 * model's prose included, is left as written. A heading the reference does not have cannot be fixed here,
 * so the caller checks again and still refuses such a document.
 *
 * Why it exists: the protected claims are the definition's, not the model's wording. Measured 2026-10-08
 * with command-a on a folder persona, the model turned two "Never" rules into positive phrasing merged with
 * others and did not restore them in two repairs; without this, compile wrote nothing. The caller says how
 * many it restored, so a restored rule is never presented as the model's.
 */
export function enforceProtected(
  reference: string,
  written: string,
  report: FaithfulnessReport,
): { document: string; restored: number; removed: number; protectedClaims: number } {
  const ref = claimsBySection(reference);
  const protectedClaims = DEFAULT_SECTIONS.reduce((n, section) => n + (ref.get(section)?.length ?? 0), 0);
  const lines = written.split(/\r?\n/);
  const refLines = reference.split(/\r?\n/);
  const sectionStart = (all: string[], section: string): number => all.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase() === section);
  const sectionEnd = (all: string[], start: number): number => {
    const next = all.findIndex((l, i) => i > start && /^##\s+/.test(l));
    return next === -1 ? all.length : next;
  };
  const bulletText = (l: string): string | undefined => l.match(/^\s*[-*]\s+(\S.*)$/)?.[1]?.replace(/^\*\*[^*]+\*\*:?\s*/, "").trim();
  const labelOf = (l: string): string | undefined => l.match(/^\s*\*\*([^*]+?):?\*\*\s*$/)?.[1]?.trim().toLowerCase();
  let removed = 0;
  let restored = 0;

  for (const f of report.findings) {
    if (f.kind !== "invented" || f.section === "(sections)") continue;
    const start = sectionStart(lines, f.section);
    if (start === -1) continue;
    const end = sectionEnd(lines, start);
    const at = lines.findIndex((l, i) => i > start && i < end && bulletText(l) === f.text);
    if (at !== -1) {
      lines.splice(at, 1);
      removed += 1;
    }
  }

  for (const f of report.findings) {
    if (f.kind !== "dropped") continue;
    // The label the reference puts it under, if any (**Always:** / **Never:**).
    const refStart = sectionStart(refLines, f.section);
    const refAt = refLines.findIndex((l, i) => i > refStart && bulletText(l) === f.text);
    let label: string | undefined;
    for (let i = refAt - 1; i > refStart && label === undefined; i -= 1) label = labelOf(refLines[i] ?? "");

    // Only inside a section the model wrote: a document missing whole protected sections is not a version
    // of this persona to correct, and stays refused.
    const start = sectionStart(lines, f.section);
    if (start === -1) continue;
    const end = sectionEnd(lines, start);
    let insertAt = end;
    const labelAt = label === undefined ? -1 : lines.findIndex((l, i) => i > start && i < end && labelOf(l) === label);
    if (labelAt !== -1) {
      insertAt = labelAt + 1;
      while (insertAt < end && bulletText(lines[insertAt] ?? "") !== undefined) insertAt += 1;
    } else {
      // After the section's last bullet, or right after its heading when it has none.
      let last = -1;
      for (let i = start + 1; i < end; i += 1) if (bulletText(lines[i] ?? "") !== undefined) last = i;
      insertAt = last === -1 ? start + 1 : last + 1;
      if (label !== undefined) {
        lines.splice(insertAt, 0, `**${label.charAt(0).toUpperCase()}${label.slice(1)}:**`);
        insertAt += 1;
      }
    }
    lines.splice(insertAt, 0, `- ${f.text}`);
    restored += 1;
  }
  return { document: lines.join("\n"), restored, removed, protectedClaims };
}
