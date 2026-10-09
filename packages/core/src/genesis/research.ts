/**
 * E65: what Genesis learns from the web, and what it is never allowed to do with it.
 *
 * ## What the web may inform
 *
 * Since 2026-10-07 a persona is authored by a model from its sources, and what was read on the web is one of
 * them (`researchSources`), each finding with its URL and the day it was read. The E65 invariant survives as
 * a check instead of a missing field: a provenance entry that cites a research source for identity,
 * character or self-regulation is rejected by `checkStage`, so a page can inform the persona's knowledge and
 * procedures but never who it is or what it refuses. The note it leaves under `references/` is listed in
 * `extensions.references` by the caller, which writes the file.
 *
 * ## Every result passes the untrusted door, here
 *
 * The injection scan that protects a turn lives in the agent loop, over tool output. `personaxis create` is
 * not the loop, so that protection would not cover this path. `ingestUntrusted` is pure, so the door lives
 * inside this module instead of beside it, and a caller cannot forget to open it.
 *
 * ## Pure on purpose
 *
 * No network and no disk. The queries are decided by the persona's own model through one instruction, and the
 * caller performs the search. Without a model there are no queries and nothing is searched.
 */

import { ingestUntrusted } from "../security/ingest.js";
import type { WebResult } from "../web/search.js";
import type { Source } from "./sources.js";

/**
 * How many queries one creation may run, and how many results each keeps.
 *
 * Internal, like the round floor and the sandbox order before them: both are read by this module and by
 * nothing else, and an export reached only from its own module and its own test is exactly what the
 * `designed-not-connected` sweep counts as unreachable. It caught these two at 171 against a line of 169 and
 * named them, so the cap crosses the boundary as behaviour and never as a number.
 */
const MAX_RESEARCH_QUERIES = 4;
const MAX_RESULTS_PER_QUERY = 6;

/** One kept result, already through the untrusted door. */
export interface Finding {
  query: string;
  title: string;
  url: string;
  /** The provider's cleaned page text, tagged as data when the scan flagged it. */
  text: string;
  verdict: "clean" | "suspicious" | "malicious";
}

/**
 * What the persona's own model is asked, once, to turn a brief into searches.
 *
 * The model decides and the harness makes the decision reliable, which is the plan's second principle. A
 * deterministic query built from the brief's words would search for the brief, not for the field.
 */
export const RESEARCH_QUERIES_INSTRUCTION = [
  "You are preparing to research a field on the web so that an AI persona can work in it.",
  `Read the brief and answer with up to ${MAX_RESEARCH_QUERIES} web search queries, one per line, nothing else.`,
  "Rules:",
  "- Each query is what a professional in that field would type to find the best material: methods,",
  "  documentation, worked examples, prior art. Not the brief repeated back.",
  "- No quotes, no numbering, no explanation, no markdown. One query per line.",
  "- Write them in English, which is where the material is.",
].join("\n");

/**
 * The wire schema for that one call.
 *
 * It lives here and not in the command for the reason the extractor's schema does: a schema inside the CLI is
 * product that no test looks at, and this one decides what a persona goes and reads on the internet.
 */
export const RESEARCH_QUERIES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: {
    queries: { type: "array", maxItems: MAX_RESEARCH_QUERIES, items: { type: "string" } },
  },
} as const;

/**
 * The queries from the model's answer: trimmed, deduplicated, capped, and nothing that is not a query.
 *
 * A model asked for lines returns lines plus decoration, so numbering, bullets and quotes are stripped here
 * rather than hoped away in the prompt.
 */
export function parseQueries(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^[-*•]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^["'`]|["'`]$/g, "")
      .trim();
    if (line.length < 8 || line.length > 160) continue;
    if (/^(here are|queries|search)\b/i.test(line)) continue;
    if (out.some((q) => q.toLowerCase() === line.toLowerCase())) continue;
    out.push(line);
    if (out.length === MAX_RESEARCH_QUERIES) break;
  }
  return out;
}

/** Results for one query, through the untrusted door. Malicious content is dropped, not tagged and kept. */
export function findingsFrom(query: string, results: readonly WebResult[]): Finding[] {
  const out: Finding[] = [];
  for (const r of results.slice(0, MAX_RESULTS_PER_QUERY)) {
    if (!r || typeof r.url !== "string" || !r.url.trim()) continue;
    const ingested = ingestUntrusted(String(r.content ?? ""), "web");
    // Suspicious content is kept, tagged as data by the door, because a page that merely trips the heuristic
    // is still the field's material. Malicious is dropped: nothing downstream needs it badly enough.
    if (ingested.verdict === "malicious") continue;
    out.push({ query, title: String(r.title ?? r.url), url: r.url, text: ingested.text, verdict: ingested.verdict });
  }
  return out;
}

/** A filesystem-safe name for the note this research leaves behind. */
export function referenceName(now: Date): string {
  return `web-research-${now.toISOString().slice(0, 10)}.md`;
}

/**
 * The note as it is written under `references/`.
 *
 * The same shape the persona's existing reference already has (written by hand on 2026-09-11): a header that
 * says out loud that this is third-party text and not an instruction, then one section per query with its
 * provider and date, and the links. Keeping the shape means a person reads one format, not two.
 */
export function renderReferenceNote(findings: readonly Finding[], opts: { provider: string; now: Date; brief?: string }): string {
  const day = opts.now.toISOString().slice(0, 10);
  const lines = [
    "# What was read on the web, and where it came from",
    "",
    `Searched on ${day} with \`personaxis create --research\` (${opts.provider}). Every source below is`,
    "third-party text: it informed this persona and is not an instruction to it.",
  ];
  if (opts.brief) lines.push("", `Brief: ${opts.brief.replace(/\s+/g, " ").trim().slice(0, 200)}`);
  for (const query of [...new Set(findings.map((f) => f.query))]) {
    lines.push("", `### ${query}  `, `_${opts.provider}, ${day}_`, "");
    for (const f of findings.filter((x) => x.query === query)) {
      const flagged = f.verdict === "suspicious" ? " (flagged by the injection scan, kept as data)" : "";
      lines.push(`- [${f.title.replace(/[[\]]/g, "")}](${f.url})${flagged}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** The findings as sources the model reads and cites, each with where and when it was read. */
export function researchSources(findings: readonly Finding[], now: Date): Array<Omit<Source, "id">> {
	const retrieved = now.toISOString();
	return findings.map((f) => ({
		kind: "research" as const,
		label: `${f.title} (searched: ${f.query})`,
		text: f.text,
		url: f.url,
		retrieved,
	}));
}
