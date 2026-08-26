/**
 * The turn, written down.
 *
 * `TurnObserver` has existed since the runner did, with a comment saying it is what
 * the runner tells the record and that the runner does not write it itself. Nothing
 * implemented it, so every turn a persona took went unrecorded: the chain knew what
 * its coordinates were doing and nothing about what it had been asked or what it
 * answered.
 *
 * That gap is what kept `PersonaAgent` alive past its usefulness. The REPL reads the
 * conversation off the agent's own `lastMessages` and the cost off its `budget`, so
 * the agent could not be retired while it was the only thing that knew either. Both
 * are facts about a turn, the record is what holds facts about a persona, and once
 * they are in it the REPL is reading a projection instead of holding a loop.
 *
 * ## What is written, and what deliberately is not
 *
 * A turn opens with what was asked and closes with what came back, how it ended, how
 * many steps it took and what it cost when anybody could say. The answer is written as
 * a message, attributed to the persona, because it is the persona speaking.
 *
 * Provider material is not written. Reasoning signatures and encrypted blocks are
 * sealed to whoever issued them and cannot be replayed elsewhere, and a chain that
 * cannot be edited is the wrong place for something that stops being valid. The record
 * keeps the text and, when a caller has one, a reference with its issuer stamped.
 *
 * ## Every path closes, including the ones nobody planned
 *
 * The runner promises to call `closed` exactly once per turn, on every route through
 * it, and this writes the close it is given rather than deciding what happened. A turn
 * that failed, was abandoned or was refused before it began is a turn with an ending,
 * and an ending nobody wrote down is a hole a reader fills in with a guess.
 */

import type { Author } from "../record/entry.js";
import type { Journal } from "../record/journal.js";
import type { TurnObserver } from "./service.js";
import type { TurnOutcome, TurnRequest } from "./vocabulary.js";

/** Who a turn is attributed to, in the record's vocabulary rather than the seam's. */
function askerOf(request: TurnRequest): Author {
	return request.asker.kind === "human"
		? { kind: "human", id: request.asker.id }
		: { kind: "persona", id: request.asker.id };
}

/**
 * How the persona is attributed when it answers.
 *
 * The asker's own identity when the asker is the persona, and otherwise the persona
 * this record belongs to. It is never the person who asked: an answer credited to the
 * person who asked for it is the forgery the author invariant exists to prevent.
 */
function answererOf(personaId: string): Author {
	return { kind: "persona", id: personaId };
}

export interface RecordingOptions {
	/** Where entries go. */
	readonly journal: Journal;
	/** Whose record this is, so an answer is attributed to the right persona. */
	readonly personaId: string;
}

/**
 * A `TurnObserver` that writes turns into a record.
 *
 * Separate from the runner because the runner owns endings and the record owns facts,
 * and a runner that wrote its own would be deciding both what happened and what is
 * remembered about it.
 */
export function recordTurns({ journal, personaId }: RecordingOptions): TurnObserver {
	return {
		opened(request) {
			journal.append(askerOf(request), {
				type: "turn-open",
				turn: request.turn,
				prompt: request.prompt,
			});
		},

		closed(outcome: TurnOutcome) {
			// The answer first, so a reader walking the entries meets what was said
			// before it meets the note that the turn ended.
			if (outcome.answer.length > 0) {
				journal.append(answererOf(personaId), {
					type: "message",
					turn: outcome.turn,
					role: "assistant",
					text: outcome.answer,
				});
			}

			// The close is the runtime's, not the persona's: the persona produced an
			// answer, the runtime decided the turn was over and why.
			journal.append(
				{
					kind: "runtime",
					mechanism: "turn",
					reason: `the turn ended: ${outcome.stopReason}`,
				},
				{
					type: "turn-close",
					turn: outcome.turn,
					outcome: outcome.stopReason,
					// A close the runtime writes for a turn that never closed itself is
					// synthetic, and that is exactly `abandoned`. Saying so keeps a
					// transcript honest about which endings the loop chose.
					synthetic: outcome.stopReason === "abandoned",
					spent: {
						steps: outcome.steps,
						...(outcome.cost === undefined
							? {}
							: { tokens: outcome.cost.tokens, usd: outcome.cost.usd }),
					},
				},
			);
		},
	};
}
