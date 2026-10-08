/**
 * Genesis creation report: where every field of the persona came from.
 *
 * The artifact an auditor, a buyer or the author's future self reads before trusting a persona. Since
 * 2026-10-07 every field is decided by a model stage by stage, so the report shows the sources, each stage's
 * reasoning, and each field's provenance: a quote from a named source, or what it was inferred from. What
 * was inferred is listed on its own, because that is what a person should read first.
 */

import { describeImprovementMode } from "../governance.js";
import type { AuthoredPersona, FieldProvenance } from "./author.js";
import type { InterviewTurn } from "./interview.js";
import type { Source } from "./sources.js";

/**
 * Keys that probably name the same thing, such as `verifiability` and `verified_claims` (E176). They are
 * flagged, never merged: a rule that merges by spelling also merges `communication` and `community`, and a
 * merge cannot be undone by reading the report, while a false flag costs a glance.
 */
function possiblySame(keys: readonly string[]): Array<[string, string]> {
	const head = (k: string): string => k.split("_")[0] ?? k;
	const lcp = (a: string, b: string): number => {
		let i = 0;
		while (i < a.length && i < b.length && a[i] === b[i]) i++;
		return i;
	};
	const pairs: Array<[string, string]> = [];
	for (let i = 0; i < keys.length; i++) {
		for (let j = i + 1; j < keys.length; j++) {
			const [a, b] = [keys[i], keys[j]];
			const [ha, hb] = [head(a), head(b)];
			const common = lcp(ha, hb);
			const contained = Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a));
			if (contained || (common >= 6 && common / Math.min(ha.length, hb.length) >= 0.75)) pairs.push([a, b]);
		}
	}
	return pairs;
}

const cell = (s: string, n = 100): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim().slice(0, n);

/** Render the creation report (markdown). */
export function renderCreationReport(
	authored: AuthoredPersona,
	sources: readonly Source[],
	gates: Array<{ name: string; pass: boolean; detail: string }>,
	extra: {
		/** What did not go as asked and was worked around: a failed web search, for instance. */
		notes?: readonly string[];
		model?: string;
		/** The interview's questions, answered or skipped. */
		interview?: readonly InterviewTurn[];
	} = {},
): string {
	const { notes = [], model, interview = [] } = extra;
	const { spec, stages } = authored;
	const meta = spec.metadata as { name: string; created: string };
	const all: FieldProvenance[] = stages.flatMap((s) => s.provenance);
	const inferred = all.filter((p) => !p.quote && p.inferred);
	const lines: string[] = [
		`# Creation report, ${meta.name}`,
		"",
		`Authored by \`personaxis create\` on ${meta.created}${model ? ` with ${model}` : ""}, one model call per stage. Every field below`,
		"says where it came from: a quote from a source, or what it was inferred from. Read the inferred ones first.",
		"",
		"## Gates",
		"",
		...gates.map((g) => `- ${g.pass ? "✅" : "❌"} **${g.name}**, ${g.detail}`),
		"",
		...(notes.length ? ["## Worked around", "", ...notes.map((n) => `- ⚠️ ${n}`), ""] : []),
		"## Sources",
		"",
		...sources.map((s) => `- **${s.id}** (${s.kind}) ${cell(s.label, 120)}${s.url ? `, ${s.url}${s.retrieved ? `, read ${s.retrieved.slice(0, 10)}` : ""}` : ""}`),
		"",
		`## Inferred, not stated by a source (${inferred.length})`,
		"",
		...(inferred.length ? inferred.map((p) => `- \`${p.path}\`: ${cell(p.inferred ?? "", 200)}`) : ["(none: every field quotes a source)"]),
		"",
		...(interview.length
			? [
					`## Interview (${interview.filter((t) => t.answer !== undefined).length} answered, ${interview.filter((t) => t.answer === undefined).length} skipped)`,
					"",
					...interview.map((t) => `- ${t.answer === undefined ? "skipped" : "answered"} [${t.question.stage}] ${cell(t.question.question, 200)}${t.answer === undefined ? "" : `\n  ${cell(t.answer, 300)}`}`),
					"",
				]
			: []),
		"## Each stage",
		"",
	];
	for (const s of stages) {
		lines.push(`### ${s.stage}${s.attempts > 1 ? ` (needed ${s.attempts - 1} repair${s.attempts > 2 ? "s" : ""})` : ""}`, "", cell(s.reasoning, 1200), "", "| Field | From |", "|---|---|");
		for (const p of s.provenance) {
			const from = p.quote ? `${p.source}: "${cell(p.quote, 120)}"` : `inferred: ${cell(p.inferred ?? "", 120)}`;
			lines.push(`| \`${p.path}\` | ${from} |`);
		}
		lines.push("");
	}

	const keysOf = (o: unknown): string[] => Object.keys((o ?? {}) as Record<string, unknown>);
	const similar = [
		...possiblySame(keysOf((spec.values_and_drives as { values?: unknown } | undefined)?.values)).map((p) => ["value", ...p]),
		...possiblySame(keysOf((spec.character as { virtues?: unknown } | undefined)?.virtues)).map((p) => ["virtue", ...p]),
		...possiblySame(keysOf((spec.personality as { traits?: unknown } | undefined)?.traits)).map((p) => ["trait", ...p]),
	];
	if (similar.length) {
		lines.push("## Possibly the same", "", "Kept as written. If a pair names one thing, delete one of them in the spec.", "");
		for (const [kind, a, b] of similar) lines.push(`- ${kind}: \`${a}\` and \`${b}\``);
		lines.push("");
	}

	const mode = String((spec.improvement_policy as { mode?: unknown } | undefined)?.mode ?? "locked");
	lines.push("## How it evolves", "", describeImprovementMode(mode), "", "Change it with `personaxis improve <mode>`.", "");
	return lines.join("\n");
}
