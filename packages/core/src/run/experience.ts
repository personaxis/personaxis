/**
 * E117: what a turn was like for the persona, as the living loop can observe it.
 *
 * ## Why this exists
 *
 * Measured on 2026-09-23. After every turn the living loop observed ONE thing: the sentence the
 * person typed. It never saw what the persona did with it or how that went, so a persona that had
 * just broken the same game three times and one that delivered it first time evolved identically
 * when they were told the same words. The layers that exist for exactly this, affect,
 * self-regulation and metacognition, were being moved by the request and never by the work.
 *
 * ## What goes in, and what does not
 *
 * Only facts the runtime established itself: how the turn ended, what its own checks found in what
 * was delivered, what it could not check, whether it stopped to ask, what the gate refused. Never
 * the model's own account of how it went, because that is the one party with a reason to say it went
 * well. It is observed with provenance `internal`, which is what the loop already calls a fact of its
 * own making, so it cannot carry the preferences or the self-edits that only a person's words may.
 *
 * A turn with none of these, a conversational answer that touched nothing, returns nothing: there is
 * no experience to observe beyond the words, and a second appraisal would be a model call for nothing.
 */

import type { Evolver } from "./evolving.js";
import type { TurnOutcome } from "./vocabulary.js";

/** Tools whose use means the persona stopped to ask a person rather than decide. */
const ASKED = new Set(["ask_person"]);

const ENDINGS: Partial<Record<TurnOutcome["stopReason"], string>> = {
	budget: "It ran out of room before it was done and closed with what it had.",
	stopped: "It stopped early on a condition its operator declared.",
	refused: "A guard refused something it could not continue without.",
	interrupted: "The person interrupted it.",
	empty: "The model produced nothing usable, twice.",
	failed: "It failed in a way it could not carry on through.",
	abandoned: "It never closed the turn itself; the runtime had to.",
};

/** The experience of a turn, in plain words, or undefined when there was none beyond the request. */
export function experienceOf(outcome: TurnOutcome): string | undefined {
	const lines: string[] = [];

	const ending = ENDINGS[outcome.stopReason];
	if (ending) lines.push(ending);
	if (outcome.failure) lines.push(`The turn failed: ${outcome.failure.code}.`);

	const checks = outcome.delivered?.checks ?? [];
	if (checks.length > 0) {
		const failed = checks.filter((check) => !check.passed);
		if (failed.length === 0) {
			lines.push(`What it delivered was checked and it works: ${checks.length} of ${checks.length} checks passed.`);
		} else {
			const why = failed.map((check) => check.reason ?? `${check.what}: ${check.how}`).join("; ");
			lines.push(`What it delivered was checked and failed ${failed.length} of ${checks.length} checks: ${why}.`);
		}
	}
	const unverified = outcome.delivered?.unverified ?? [];
	if (unverified.length > 0) lines.push(`It left ${unverified.length} thing(s) nobody could check: ${unverified.join(", ")}.`);

	const calls = outcome.calls ?? [];
	if (calls.some((call) => ASKED.has(call.tool))) lines.push("It stopped to ask the person for something it did not have.");
	const denied = calls.filter((call) => call.verdict === "denied");
	if (denied.length > 0) lines.push(`The gate refused ${denied.length} of its calls.`);

	if (lines.length === 0) return undefined;
	// The heading is neutral on purpose: the offline appraiser counts words, and a heading that said
	// "the work" read as one point of success on every turn, whatever happened in it.
	return ["What happened in the turn it just finished, as the runtime recorded it:", ...lines.map((line) => `- ${line}`)].join("\n");
}

/**
 * A turn, lived through: the request and then the experience, observed by the persona's own loop.
 *
 * One function for every surface that does work, because on 2026-09-23 only one of the four did
 * this at all. The TUI observed the request; the editor over ACP, a service run and a headless
 * `-p` call observed nothing, so a persona working through any of them never changed however much
 * it worked, and those are the paths the workspace sends work down. Two copies of this would drift
 * the way the compiled document once did between compile and the live recompile.
 *
 * Never throws. Living through a turn is what happens after the answer, and the note on the turn
 * existing to answer is explicit that nothing accessory may cost it one.
 */
export async function livedThrough(
	evolver: Pick<Evolver, "observe">,
	turn: { readonly request: string; readonly outcome: TurnOutcome; readonly sessionId?: string },
): Promise<void> {
	const session = turn.sessionId === undefined ? {} : { sessionId: turn.sessionId };
	await evolver.observe({ observation: turn.request, source: "user", actor: "actor-llm", ...session }).catch(() => undefined);
	const experience = experienceOf(turn.outcome);
	if (experience === undefined) return;
	await evolver.observe({ observation: experience, source: "internal", actor: "runtime-context", ...session }).catch(() => undefined);
}
