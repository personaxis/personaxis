/**
 * The REPL's own compactions, written into the persona's record.
 *
 * E25 put the LOOP's compactions into the record by handing the plan out through the
 * seam, where the runner writes it. That covers a compaction taken inside a turn and
 * nothing else, and this surface takes two more: `maybeAutoCompact` when the window
 * fills between turns, and `/compact` when a person asks for one. Both change what the
 * persona will be shown next, which is the whole definition of a compaction here, and
 * neither happens inside a turn, so no observer was ever going to see them.
 *
 * Composed from what already exists rather than given an API of its own. The author and
 * the body come from `compaction`, the lock and the verify-before-append come from
 * `writingToRecord`, and this file only puts the three together in the one place both
 * call sites can share. A second way to spell a compaction in the same chain is the
 * thing the entry was designed to avoid.
 *
 * ## The author is the runtime, even for `/compact`
 *
 * A person asking for a compaction did not perform one; the runtime did, at their
 * request, and the request goes in the reason where a reader can see it. Attributing it
 * to the person would put their hand on a decision about what to drop that they never
 * made in detail, and attributing it to the persona would be worse: the persona did not
 * choose to forget.
 */

import { compaction, record as recordApi } from "@personaxis/core";

/** Which of the two REPL compactions this was, in the words the record will carry. */
export type ReplCompaction =
	| { readonly kind: "auto"; readonly pct: number }
	| { readonly kind: "asked" };

/**
 * The reason, written once and read by both the author and the body.
 *
 * One string rather than two, for the same reason the seam carries one: two accounts of
 * one trigger drift, and the drift is invisible because each half looks right alone.
 */
export function whyCompacted(what: ReplCompaction): string {
	return what.kind === "auto"
		? `the session window reached ${Math.round(what.pct * 100)}%`
		: "a person asked for it at the prompt";
}

/**
 * Writes one compaction into the persona's record.
 *
 * Never throws. A compaction that could not be written down is worth saying out loud
 * and is not worth losing the compacted conversation over: the person keeps what they
 * have, and hears that the record does not know about it. Same rule the turn observer
 * follows, and for the same reason.
 */
export async function recordReplCompaction(
	personaPath: string,
	statePath: string,
	what: ReplCompaction,
	plan: compaction.CompactionPlan,
	onProblem: (problem: Error) => void,
): Promise<void> {
	const why = whyCompacted(what);
	try {
		await recordApi.writingToRecord(personaPath, statePath, {}, (journal) => {
			journal.append(compaction.compactionAuthor(why), compaction.compactionEntry(plan, why));
		});
	} catch (thrown) {
		onProblem(thrown instanceof Error ? thrown : new Error(String(thrown)));
	}
}
