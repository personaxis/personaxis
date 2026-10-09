/**
 * The material a persona is authored from, each piece with an id the model cites.
 *
 * Since 2026-10-07 every field of a persona comes from a model reading these, and every field says which
 * one it came from or what it was inferred from. The research behind it: skills a model writes without
 * sources do not help (SkillsBench, -1.3 points), and a persona a model fills without anchoring drifts
 * towards an upbeat generic one (Li et al., NeurIPS 2025).
 */

export type SourceKind = "brief" | "project" | "import" | "transcript" | "research" | "answer";

export interface Source {
	/** `S1`, `S2`… in the order given; what a provenance entry cites. */
	id: string;
	kind: SourceKind;
	/** Where it came from, for the report: a file, a URL, "interview question 3". */
	label: string;
	text: string;
	/** For material found on the web: the page and the day it was read. */
	url?: string;
	retrieved?: string;
}

/** Number the sources in order. */
export function numberSources(items: ReadonlyArray<Omit<Source, "id">>): Source[] {
	return items.map((s, i) => ({ ...s, id: `S${i + 1}` }));
}

/** The sources as the model reads them: each fenced, with its id and what it is. */
export function renderSources(sources: readonly Source[]): string {
	return sources
		.map((s) => {
			const where = s.url ? ` (${s.url}${s.retrieved ? `, read ${s.retrieved.slice(0, 10)}` : ""})` : "";
			return `<source id="${s.id}" kind="${s.kind}" label="${s.label.replace(/"/g, "'")}"${where ? ` from="${where.trim()}"` : ""}>\n${s.text.trim()}\n</source>`;
		})
		.join("\n\n");
}

const normal = (s: string): string =>
	s
		.toLowerCase()
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.split(/\s/)
		.filter(Boolean)
		.join(" ");

/**
 * The sentence of source `id` that shares the most words with `quote`, for a repair message: a model that
 * paraphrased a quote three times in a row (measured 2026-10-07, command-a on a 15-answer interview) is shown
 * the real words instead of being told only that its own are wrong. Undefined when nothing overlaps.
 */
export function closestSentence(sources: readonly Source[], id: string, quote: string): string | undefined {
	const source = sources.find((s) => s.id === id);
	if (!source) return undefined;
	const words = (s: string): Set<string> => new Set(normal(s).split(" ").filter((w) => w.length > 2));
	const wanted = words(quote);
	let best: { sentence: string; shared: number } | undefined;
	for (const sentence of source.text.split(/(?<=[.!?])\s+|\n+/)) {
		const shared = [...words(sentence)].filter((w) => wanted.has(w)).length;
		if (shared > 0 && (!best || shared > best.shared)) best = { sentence: sentence.trim(), shared };
	}
	return best?.sentence;
}

/** Whether `quote` is in source `id`, ignoring case, spacing and curly quotes. */
export function quoteIsIn(sources: readonly Source[], id: string, quote: string): boolean {
	const source = sources.find((s) => s.id === id);
	if (!source || !quote.trim()) return false;
	return normal(source.text).includes(normal(quote));
}
