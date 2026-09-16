/**
 * E99: a sub-task that worked and then said nothing still has to tell its parent what it did.
 *
 * ## The measurement this comes from
 *
 * 2026-09-16, the four colleague runs of `E87`: three sub-tasks closed `answered` after four steps and left no
 * answer at all. The parent reported, correctly, that it had got nothing back. The work had happened: files
 * read, a page run, calls the gate allowed. All of it invisible, because the only thing that crosses a
 * delegation is the answer.
 *
 * ## Why the loop is not the place to fix it
 *
 * `agent.ts` ends a wordless turn that did real work through the ordinary completion path, on purpose: in the
 * TUI the person WATCHED the work happen, so silence at the end costs them nothing. That reasoning is right
 * there and false one boundary away, and the loop cannot tell the two apart because nothing tells it whether
 * it is a sub-task. The seam can: the closure that runs a sub-task only ever runs for sub-tasks.
 *
 * ## What it says, and what it refuses to say
 *
 * Only facts the runtime already holds: what the turn left and what running it proved (`E85`), and the tools
 * whose calls the gate allowed (`E80`). No prose invented on the persona's behalf, and no second request to
 * the model: a summary the model never wrote, handed up as its answer, would be the forgery the author
 * invariant exists to prevent.
 *
 * Nothing at all comes back when there is nothing to report, so a sub-task that truly did nothing still says
 * so in the words it already had, rather than being dressed up as having worked.
 */

/** The parts of a turn's outcome this reads. Structural, so it needs no import and no cast to accept one. */
export interface WordlessOutcome {
	readonly answer: string;
	readonly delivered?: {
		readonly checks: readonly { readonly what: string; readonly how: string; readonly passed: boolean }[];
		readonly unverified: readonly string[];
	};
	readonly calls?: readonly { readonly tool: string; readonly verdict: string }[];
}

/** How many tools are named before the rest are counted. A parent needs the shape of the work, not an inventory. */
const TOOLS_NAMED = 6;

/** The file as the workspace names it, shortened to its last segment, which is what a reader recognises. */
function shortly(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

/**
 * What a wordless turn did, in the runtime's own words, or nothing when there is nothing to tell.
 *
 * Absent rather than empty on purpose: the caller already has a sentence for a sub-task that produced nothing,
 * and replacing it with a report that says nothing happened would be two ways of saying one thing.
 */
export function wordlessReport(outcome: WordlessOutcome): string | undefined {
	if (outcome.answer.trim()) return undefined;

	const lines: string[] = [];

	for (const check of outcome.delivered?.checks ?? []) {
		lines.push(`- ${shortly(check.what)}: ${check.how}, and it ${check.passed ? "worked" : "FAILED"}`);
	}
	// Named one by one, because an absence nobody names reads as verified, which is the rule `E85` was built on.
	for (const path of outcome.delivered?.unverified ?? []) {
		lines.push(`- ${shortly(path)}: left, and nothing could check it automatically`);
	}

	// Deduped and in order: a parent reading `read_file, read_file, read_file` learns less than one reading that
	// the sub-task read files and ran the page.
	const ran = [...new Set((outcome.calls ?? []).filter((call) => call.verdict === "allowed").map((call) => call.tool))];
	const tools = ran.length > TOOLS_NAMED ? `${ran.slice(0, TOOLS_NAMED).join(", ")} and ${ran.length - TOOLS_NAMED} more` : ran.join(", ");

	if (lines.length === 0 && ran.length === 0) return undefined;

	return [
		"The sub-task finished without writing an answer. What it did, from the runtime's own record of this turn:",
		...(tools ? [`It used: ${tools}.`] : []),
		...lines,
	].join("\n");
}
