/**
 * The loop breaker, split into the half that refuses and the half that advises.
 *
 * It was already right about the escalation: notice a repetition, nudge once, and only
 * stop if it carries on. What it lacked was a place. It sat beside the loop, so
 * whatever ran the loop had to remember to consult it, and a stop that nobody consults
 * is a suggestion.
 *
 * Splitting it in two follows what the study found rather than what is convenient.
 *
 * **A stop is a refusal**, so it belongs in the cascade, where it composes with
 * everything else and where the type prevents anybody from writing a version that
 * grants. The next call does not run.
 *
 * **A nudge is not.** The reference is explicit about this and about the trap: their
 * advisory guard never rewrites a tool result, because a patched result **makes the
 * logged result lie about what the tool returned**. So a nudge here produces something
 * to add, and never a verdict and never a rewrite.
 *
 * And what gets added carries its author. A message injected into a transcript with no
 * label renders as a real request from the person, which is the fourth independent
 * sighting of the same rule and the reason it is an invariant of the record rather
 * than a precaution in one file.
 *
 * ## Why the stop is checked after the call and not before
 *
 * Denied calls count. The reference puts its detection after execution precisely so
 * refusals pass through it: a model hammering a call the gate keeps denying is exactly
 * the loop worth breaking, and a breaker that only saw successful calls would never see
 * it. So the outcome of a denied call is recorded like any other, and the next call is
 * what gets refused.
 */

import { deny, type GuardOutcome } from "../gate/verdict.js";
import type { Guard } from "../gate/waterfall.js";
import type { Author } from "../record/entry.js";
import { LoopBreaker, type BreakerVerdict } from "../loop-breaker.js";

/** Something the runtime wants added to the turn, with who wants it added. */
export interface Nudge {
	readonly author: Author;
	readonly text: string;
}

/**
 * The stop half, as a guard.
 *
 * Reads the breaker rather than owning it, because the thing that records step outcomes
 * is the loop and the thing that refuses calls is the gate, and giving one of them the
 * other's state is how they drift.
 */
export function breakerGuard(breaker: LoopBreaker): Guard {
	return {
		name: "loop-breaker",
		check: (): GuardOutcome => {
			const verdict = breaker.assess();
			if (verdict.action !== "stop") return undefined;
			return deny("loop_breaker", verdict.reason);
		},
	};
}

/**
 * The advisory half.
 *
 * Returns what to add, or nothing. It does not add it, and it does not touch a result:
 * a caller decides where an addition goes, and the only thing this insists on is that
 * whatever goes in says who put it there.
 */
export function nudgeFor(verdict: BreakerVerdict): Nudge | undefined {
	if (verdict.action !== "nudge") return undefined;
	return {
		author: {
			kind: "runtime",
			mechanism: "loop-breaker",
			reason: "the trailing run repeated without progress",
		},
		text: verdict.reason,
	};
}
