/**
 * E134 and E149: what the engine found broken in what a turn delivered, in the words Personaxis says it.
 *
 * One function for every surface that shows a turn, so the terminal and an editor say the same sentence: the TUI
 * colours it (`repl/render.ts`, `engineVerdictLines`), an editor driven over ACP gets it as text
 * (`workspace/persona-agent.ts`). Its own module and not a part of the renderer, because `personaxis-acp` keeps its
 * module graph small for the editor's start-up and has no use for a terminal's colours.
 *
 * Only failed checks, because a line under every good delivery would be noise nobody reads, and paths relative to the
 * project, like every other path a person reads in a transcript.
 */
import { relative } from "node:path";

/** What the engine checked in a turn's delivery, as the turn's outcome carries it. */
export type DeliveredChecks =
	| { readonly checks: ReadonlyArray<{ readonly what: string; readonly how: string; readonly passed: boolean; readonly reason?: string }> }
	| undefined;

/** The label every surface puts before the sentence. */
export const VERDICT_LABEL = "⚠ Checked by Personaxis:";

/** One sentence per failed check, without the label, e.g. `game.html does NOT run: on load, ...`. */
export function verdictSentences(delivered: DeliveredChecks, cwd: string): string[] {
	const failed = (delivered?.checks ?? []).filter((check) => !check.passed);
	return failed.map((check) => {
		const shown = relative(cwd, check.what) || check.what;
		const said = (check.reason ?? `${check.what}: ${check.how}, and it failed`).split(check.what).join(shown);
		return said.startsWith(shown) ? said : `${shown}: ${said}`;
	});
}
