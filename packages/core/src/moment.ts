/**
 * E118: how the persona is right now, when that is no longer what its frozen identity says.
 *
 * ## Why this exists
 *
 * Measured on 2026-09-23. The working agent received the identity compiled at the start of the
 * session and nothing about the persona's state after that, so inside a working session its ten
 * layers could move and nothing about how it worked would. The identity stays frozen, and that is
 * a decision with two reasons written in the study's synthesis: the cached prefix, and the record
 * being able to say which identity a call was judged against. So the state travels the other way
 * the synthesis names for things that change: the message of the moment, after the stable prefix.
 *
 * ## Why it says so little
 *
 * Only the lines of "How your traits express right now" that no longer match the frozen identity,
 * written by the same function the compiler uses, so a line that did not change can never read as
 * changed. When nothing changed it says nothing at all. Telling an agent more than it needs is
 * measured to paralyse it (five of twelve turns without a tool, in the reference), and the band
 * prose itself is measured to move behaviour (RQ3 of the paper, sigma 0.56 on average), so the
 * smallest text that carries the change is the whole design.
 */

import { EXPRESSION_HEADING, expressionLines } from "./compile/assemble.js";

/**
 * The block for the message of the moment, or "" when the persona is as its identity says.
 *
 * `identity` is the document the agent was handed; `persona` the spec with any applied self-edits;
 * `values` the state now. An identity without the expression section (a raw spec body, a host that
 * compiled it elsewhere) gets nothing, because every line would read as changed and the moment
 * would repeat the persona's whole temperament on every turn.
 */
export function howYouAreNow(identity: string, persona: Record<string, unknown>, values: Record<string, number> | undefined): string {
	if (values === undefined || !identity.includes(EXPRESSION_HEADING)) return "";
	const changed = expressionLines(persona, values).filter((line) => !identity.includes(line));
	if (changed.length === 0) return "";
	return ["# How you are right now", "Since this session began, these have changed from what your identity above says:", ...changed].join("\n");
}
