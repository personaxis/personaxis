/**
 * Translating an ACP prompt turn into a `TurnProduct`, as a pure function.
 *
 * The translation lives apart from the connection for the same reason
 * `host-stream.ts` split it out of `host-session.ts`: a translator with no socket
 * in it can be tested exhaustively, and this one has to be, because it is the
 * place where a foreign vocabulary becomes ours and every mistake here is a lie
 * the record then tells forever.
 *
 * ## Five words in, seven words out
 *
 * ACP names five reasons a turn ends. We name seven. The gap is not an oversight
 * on either side: they describe what the agent did, and we describe what happened
 * to the turn, which is a larger question because it includes the things that
 * happened to the agent from outside.
 *
 *     end_turn           → answered, or empty when nothing was said
 *     max_tokens         → budget
 *     max_turn_requests  → budget
 *     refusal            → refused
 *     cancelled          → whichever of ours made us cancel
 *
 * **`cancelled` is the interesting one, and it is ambiguous by construction.**
 * The specification says an agent MUST answer `cancelled` when the client sends
 * `session/cancel`, whatever else was going on. So the word describes who spoke
 * last, not why. It cannot tell a person hitting stop apart from a declared rule
 * firing apart from a ceiling being reached, and those are three different
 * things in the record: one is a human act, one is an operator's rule working,
 * and one is a limit being enforced.
 *
 * We can tell them apart, because **we are the one that sent the cancel**. So the
 * caller records why it cancelled, and this function believes it. That is the
 * whole trick, and it is why all seven of our reasons are reachable through a
 * protocol that only has five.
 *
 * ## What is deliberately not inferred
 *
 * `empty` is read from the content, never from the stop reason, because ACP says
 * `end_turn` for a turn that produced nothing just as readily as for one that
 * produced an essay. An agent that hangs up quietly and one that answers well
 * are the same word on the wire and different facts in the record.
 *
 * A sixth stop reason from a future version of the protocol is **not** guessed
 * into one of ours. It comes back `failed` with the unrecognised word carried
 * through, which is what `default-provider.ts` does with the same situation, and
 * for the same reason: whoever adds it can see where it landed.
 */

import type { run } from "@personaxis/core";

/** The seam's word for what a provider produced. Namespaced, as the barrel exports it. */
type TurnProduct = run.TurnProduct;

/**
 * The five words ACP can end a turn with.
 *
 * Written out rather than imported from the SDK's types on purpose. This list is
 * the thing the translation is a total function over, and importing it would mean
 * a version bump that adds a sixth silently widens the input while the switch
 * below keeps compiling. Named here, a new word shows up as a test failure
 * against the schema, which is `acpStopReasons` in the test file.
 */
export const ACP_STOP_REASONS = [
	"end_turn",
	"max_tokens",
	"max_turn_requests",
	"refusal",
	"cancelled",
] as const;

export type AcpStopReason = (typeof ACP_STOP_REASONS)[number];

/**
 * Why the client sent `session/cancel`.
 *
 * Only four things cancel a turn on our side, and each is one of our stop
 * reasons. There is no `other`: a cancel nobody can name is a cancel that would
 * come back as an unexplained `interrupted`, and an unexplained interruption in
 * a record is indistinguishable from a person having stopped the work.
 */
export type CancelCause =
	/** A person pressed stop. `AbortSignal` fired. */
	| "interrupted"
	/** A declared stop condition fired. The operator's rule worked. */
	| "stopped"
	/** The ledger said there was no room for another step. */
	| "budget"
	/** The gate refused something the turn could not continue without. */
	| "refused";

/** What the connection collected while the turn ran. */
export interface AcpTurnState {
	/**
	 * What the agent said, and only what the agent said.
	 *
	 * `agent_message_chunk` only. Thoughts and the echoed user message arrive on
	 * the same channel and are not the answer: putting a thought here is how a
	 * transcript ends up quoting reasoning as a reply, and echoing the prompt back
	 * is how a turn appears to answer itself.
	 */
	readonly text: string;
	/** Tool calls seen, which is the only step count ACP offers. */
	readonly steps: number;
	/** Set by the caller before it cancels, read only when ACP says `cancelled`. */
	readonly cancelCause?: CancelCause;
}

/**
 * Cost is deliberately not here.
 *
 * Everything ACP reports about spend is a session running total, so this turn's
 * share is a subtraction across two turns, and a translator handed one turn has
 * no second number to subtract. The provider owns the session, so the provider
 * owns the arithmetic and attaches the result. See `AcpUsage` in `provider.ts`
 * for what passing the total straight through would have cost.
 */

/**
 * Whether a word is one of the five.
 *
 * Exists so the provider can decide before calling `productOf`, rather than
 * having the translation take `string` and lose the type on the way in.
 */
export function isAcpStopReason(word: string): word is AcpStopReason {
	return (ACP_STOP_REASONS as readonly string[]).includes(word);
}

/**
 * The translation. Total over the five words, and honest about anything else.
 */
export function productOf(reason: string, state: AcpTurnState): TurnProduct {
	const common = { steps: state.steps };

	switch (reason) {
		case "end_turn":
			// The content decides, not the word. See the header.
			return state.text.length > 0
				? { answer: state.text, stopReason: "answered", ...common }
				: { answer: "", stopReason: "empty", ...common };

		case "max_tokens":
		case "max_turn_requests":
			// Both are ceilings. `max_turn_requests` counts agent round trips rather
			// than tokens, but a ceiling is a ceiling and `budget` is our word for
			// having run out of room. Whatever it managed to say comes back with it:
			// the answer and the reason are separate facts.
			return { answer: state.text, stopReason: "budget", ...common };

		case "refusal":
			return { answer: state.text, stopReason: "refused", ...common };

		case "cancelled":
			// We sent the cancel, so we know why. Falling back to `interrupted` when
			// nobody recorded a cause is the conservative reading: an agent may also
			// report `cancelled` for a cancel we did not send, and attributing that
			// to a person is wrong in a smaller way than attributing it to a budget
			// that was never reached or a rule that never fired.
			return {
				answer: state.text,
				stopReason: state.cancelCause ?? "interrupted",
				...common,
			};

		default:
			// A word from a protocol version this build does not know. Naming it as
			// one of the seven would be guessing.
			return {
				answer: "",
				stopReason: "failed",
				failure: {
					code: "unrecognised_acp_stop",
					message: "the agent stopped with " + reason,
				},
				...common,
			};
	}
}

/**
 * The turn ended because something broke rather than because the agent finished.
 *
 * Separate from `productOf` because a failure has no ACP stop reason to translate:
 * the connection died, the process was not there, or a request came back an error.
 * The answer is dropped on this path, deliberately, and the header of
 * `default-provider.ts` says why in one line worth repeating: a report is not a
 * reply. Half an answer plus a failure code invites whoever renders it to show the
 * half as though the persona had chosen to stop there.
 */
export function failureOf(code: string, message: string, state: AcpTurnState): TurnProduct {
	return {
		answer: "",
		stopReason: "failed",
		failure: { code, message },
		steps: state.steps,
	};
}
