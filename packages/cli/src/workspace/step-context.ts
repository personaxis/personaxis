/**
 * Telling an agent where it is in a service, twice, from one fact.
 *
 * The step used to reach the agent as prose and only as prose: whoever built the
 * prompt wrote a sentence about it, and that sentence was everything the agent had.
 * It could not ask which step it was on, how many were left, or whether a person
 * would read what it produced before the next one started. It could only re-read
 * the paragraph it was given.
 *
 * ## Two renderings, one source
 *
 * `describeStep` writes the sentence, for the agents that exist today: none of the
 * forty reads a metadata field it was not built to expect, and Claude Code least of
 * all, because it is being driven by an adapter that speaks for it.
 *
 * `metaFor` puts the same fields on the protocol's own `_meta`, which is reserved
 * for exactly this and which an agent built against us can read without parsing
 * English.
 *
 * Both come from the same object. That is the whole design decision here: a
 * sentence and a field that are written separately can disagree, and when they do
 * the agent believes the sentence, so the field becomes a thing that is true and
 * has no effect.
 *
 * ## What it deliberately does not do
 *
 * No interpolation, no `{{step1.output}}`. The schema comment on `instruction` says
 * why and it is right: a small language in a product for non-programmers is a
 * support queue. What the previous step left is in the workspace folder and in the
 * handover, which are things a person can read too.
 */

import type { StepContext } from "@personaxis/protocol/workspace";

/**
 * The sentence an agent reads.
 *
 * Written to be true of the middle of a service as well as the ends, because "step
 * 2 of 2" and "step 2 of 7" ask for different work and a template that said only
 * "you are running a step" would flatten them.
 *
 * Returns an empty string for a run that belongs to no service, which is most of
 * them, and the caller adds nothing rather than adding a paragraph explaining that
 * there is nothing to explain.
 */
export function describeStep(step: StepContext | undefined): string {
	if (!step) return "";

	const named = step.name ? `, "${step.name}"` : "";
	const lines = [`You are step ${step.step} of ${step.of} in "${step.service}"${named}.`];

	if (step.step > 1) {
		lines.push(
			`Steps 1 to ${step.step - 1} have already run. What they left is in this workspace.`,
		);
	}
	if (step.step < step.of) {
		const remaining = step.of - step.step;
		lines.push(
			`${remaining} step${remaining === 1 ? "" : "s"} follow${remaining === 1 ? "s" : ""} yours, ` +
				`so leave what you produce where the next one can find it.`,
		);
	} else {
		lines.push("Yours is the last step, so what you leave is what the service delivers.");
	}
	if (step.approvalBefore === true) {
		// Said plainly rather than implied. An agent that knows a person is about to
		// read this writes a different handover than one producing an intermediate
		// nobody will see.
		lines.push("A person has to approve your work before anything else runs.");
	}

	return lines.join("\n");
}

/**
 * The same facts as protocol metadata.
 *
 * Namespaced under `personaxis.step` because `_meta` is a shared bag: the schema
 * says implementations must not assume anything about keys at that level, so a bare
 * `step` would be us assuming exactly that about everyone else's.
 *
 * Returns undefined rather than an empty object when there is no step, so a caller
 * spreads nothing instead of sending `_meta: {}`, which is a field that says a
 * thing was considered and found empty rather than never applying.
 */
export function metaFor(step: StepContext | undefined): Record<string, unknown> | undefined {
	if (!step) return undefined;
	return {
		"personaxis.step": {
			service: step.service,
			step: step.step,
			of: step.of,
			...(step.name === undefined ? {} : { name: step.name }),
			...(step.approvalBefore === undefined ? {} : { approvalBefore: step.approvalBefore }),
		},
	};
}
