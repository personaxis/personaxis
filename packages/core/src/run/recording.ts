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
 *
 * ## Two observers, one set of entries
 *
 * What a turn looks like in a record is decided once, by `opening` and `closing`, and
 * two observers write what they produce. `recordTurns` puts them into a journal the
 * caller owns, which is what a test and an in-memory engine want. `recordingTurns`
 * opens the persona's record for each write and lets it go, which is what a live
 * session needs: a journal held across a turn chains onto a head the file moves past
 * the moment the living loop writes a move, and the entries collide.
 *
 * The split is between where entries GO, not what they SAY. Writing the two sets
 * separately is how the durable one comes to differ from the one every test checks.
 */

import { SELF } from "../record/actor.js";
import { writingToRecord, type RecordPorts } from "../record/transaction.js";
import type { Author, RecordBody } from "../record/entry.js";
import type { Journal } from "../record/journal.js";
import type { TurnObserver } from "./service.js";
import type { TurnOutcome, TurnRequest } from "./vocabulary.js";

/** One entry, decided but not yet written anywhere. */
interface Written {
	readonly author: Author;
	readonly body: RecordBody;
}

/** Who a turn is attributed to, in the record's vocabulary rather than the seam's. */
function askerOf(request: TurnRequest): Author {
	return request.asker.kind === "human"
		? { kind: "human", id: request.asker.id }
		: { kind: "persona", id: request.asker.id };
}

/**
 * How the persona is attributed when it answers.
 *
 * `SELF`, because a record belongs to one persona and this is that persona speaking in
 * it. Its canonical id would be a second name for something the file already says, and
 * every coordinate entry in the same record already says `self`: writing `clio` here
 * would put two spellings of one actor in one chain.
 *
 * It is never the person who asked. An answer credited to the person who asked for it
 * is the forgery the author invariant exists to prevent.
 */
function answererOf(): Author {
	return { kind: "persona", id: SELF };
}

/** What opening a turn writes. */
function opening(request: TurnRequest): readonly Written[] {
	return [
		{
			author: askerOf(request),
			body: { type: "turn-open", turn: request.turn, prompt: request.prompt },
		},
	];
}

/** What closing a turn writes, in the order a reader meets it. */
function closing(outcome: TurnOutcome): readonly Written[] {
	const entries: Written[] = [];

	// The answer first, so a reader walking the entries meets what was said before it
	// meets the note that the turn ended.
	if (outcome.answer.length > 0) {
		entries.push({
			author: answererOf(),
			body: { type: "message", turn: outcome.turn, role: "assistant", text: outcome.answer },
		});
	}

	// The close is the runtime's, not the persona's: the persona produced an answer,
	// the runtime decided the turn was over and why.
	entries.push({
		author: {
			kind: "runtime",
			mechanism: "turn",
			reason: `the turn ended: ${outcome.stopReason}`,
		},
		body: {
			type: "turn-close",
			turn: outcome.turn,
			outcome: outcome.stopReason,
			// A close the runtime writes for a turn that never closed itself is
			// synthetic, and that is exactly `abandoned`. Saying so keeps a transcript
			// honest about which endings the loop chose.
			synthetic: outcome.stopReason === "abandoned",
			spent: {
				steps: outcome.steps,
				...(outcome.cost === undefined
					? {}
					: { tokens: outcome.cost.tokens, usd: outcome.cost.usd }),
			},
		},
	});

	return entries;
}

export interface RecordingOptions {
	/** Where entries go. */
	readonly journal: Journal;
}

/**
 * A `TurnObserver` that writes turns into a journal the caller owns.
 *
 * Separate from the runner because the runner owns endings and the record owns facts,
 * and a runner that wrote its own would be deciding both what happened and what is
 * remembered about it.
 *
 * For a caller whose journal outlives the turn and is the only writer to its record.
 * A live session is not that caller: use `recordingTurns`.
 */
export function recordTurns({ journal }: RecordingOptions): TurnObserver {
	const write = (entries: readonly Written[]): void => {
		for (const entry of entries) journal.append(entry.author, entry.body);
	};

	return {
		opened: (request) => write(opening(request)),
		closed: (outcome) => write(closing(outcome)),
	};
}

export interface LiveRecordingOptions extends RecordPorts {
	/** The persona whose record this is. */
	readonly personaPath: string;
	/** The persona's write lock, which is its state file's path. */
	readonly statePath: string;
	/**
	 * Told when a turn could not be written down, rather than nothing being told.
	 *
	 * A person who got their answer keeps it: refusing to deliver a reply because the
	 * disk is full helps nobody. But a turn that is not in the record did not happen as
	 * far as this persona is concerned, and swallowing that is the one failure a record
	 * cannot have. Without a handler it goes to stderr, which is louder than nothing and
	 * quieter than a caller who decided.
	 */
	readonly onProblem?: (problem: Error) => void;
}

/**
 * A `TurnObserver` that writes turns into a persona's record on disk.
 *
 * Opens the record for each write and lets it go, under the persona's lock, which is
 * what makes it safe beside the living loop: a journal held across a turn chains onto
 * a head the file moves past the moment a move is written, and the two collide.
 *
 * It does not throw. The runner waits for it, so a throw here loses an answer the
 * person is already reading, and there is nothing useful to do with that.
 */
export function recordingTurns(options: LiveRecordingOptions): TurnObserver {
	const { personaPath, statePath, onProblem, ...ports } = options;
	const report =
		onProblem ??
		((problem: Error) => {
			process.stderr.write(`personaxis: a turn was not written to the record (${problem.message})\n`);
		});

	const write = async (entries: readonly Written[]): Promise<void> => {
		try {
			await writingToRecord(personaPath, statePath, ports, (record) => {
				for (const entry of entries) record.append(entry.author, entry.body);
			});
		} catch (thrown) {
			report(thrown instanceof Error ? thrown : new Error(String(thrown)));
		}
	};

	return {
		opened: (request) => write(opening(request)),
		closed: (outcome) => write(closing(outcome)),
	};
}
