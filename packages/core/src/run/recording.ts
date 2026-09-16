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

import { compactionAuthor, compactionEntry } from "../compaction/measured.js";
import { SELF } from "../record/actor.js";
import { delegationAuthor } from "./delegation.js";
import { writingToRecord, type RecordPorts } from "../record/transaction.js";
import type { Author, RecordBody } from "../record/entry.js";
import type { Journal } from "../record/journal.js";
import type { TurnObserver } from "./service.js";
import type { TurnCall, TurnOutcome, TurnRequest } from "./vocabulary.js";

/** One entry, decided but not yet written anywhere. */
interface Written {
	readonly author: Author;
	readonly body: RecordBody;
}

/**
 * Who a turn is attributed to, in the record's vocabulary rather than the seam's.
 *
 * Passed through rather than narrowed. It used to collapse everything that was not a
 * human into a persona, so a program driving the persona was written down as the
 * persona asking itself.
 */
function askerOf(request: TurnRequest): Author {
	const asker = request.asker;
	switch (asker.kind) {
		case "human":
			return { kind: "human", id: asker.id };
		case "persona":
			return { kind: "persona", id: asker.id };
		case "component":
			return { kind: "component", name: asker.name };
	}
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

/**
 * What opening a turn writes.
 *
 * Two entries when the turn is a delegated sub-task, and the photograph goes FIRST
 * because it is what the turn after it happened under. Written here rather than by
 * whoever delegated, for the reason this whole file exists: the runner owns endings and
 * the record owns facts, and a second writer would be a second account of one turn.
 */
function opening(request: TurnRequest): readonly Written[] {
	const entries: Written[] = [];

	if (request.delegation) {
		entries.push({
			// The runtime's, naming who it was photographed from. Not the parent's own
			// author: the parent did not write this sentence, the delegation did, and a
			// record that said otherwise would put a claim in a persona's mouth.
			author: delegationAuthor(idOf(request)),
			body: {
				type: "delegation",
				depth: request.delegation.depth,
				// Empty rather than absent, and they are different facts: a parent that
				// narrowed nothing hands down nothing and the child follows the current
				// default, which is what an empty list says here.
				directories: request.delegation.inherited.directories ?? [],
				sandbox: request.delegation.inherited.sandbox ?? null,
				task: request.prompt,
			},
		});
	}

	entries.push({
		author: askerOf(request),
		body: { type: "turn-open", turn: request.turn, prompt: request.prompt },
	});

	return entries;
}

/** Who asked, as one string, for a sentence that has to name them. */
function idOf(request: TurnRequest): string {
	const asker = request.asker;
	return asker.kind === "component" ? `component:${asker.name}` : asker.id;
}

/**
 * Who a call entry is attributed to: the gate, because the verdict is what the entry says. The persona
 * asked for the call and the entry names the tool it asked for, but refusing or allowing it was not the
 * persona's act, and a record that put the verdict in its mouth would be the forgery the author exists
 * to prevent.
 */
const GATE: Author = { kind: "runtime", mechanism: "gate", reason: "the gate decided on a call the persona made" };

/** One call as the record writes it. Absent fields stay absent: an allowed call has no refusal to give. */
function callEntry(turn: string, call: TurnCall): RecordBody {
	return {
		type: "call",
		turn,
		callId: call.callId,
		tool: call.tool,
		verdict: call.verdict,
		...(call.reason === undefined ? {} : { reason: call.reason }),
		...(call.used === undefined ? {} : { used: call.used }),
	};
}

/** What closing a turn writes, in the order a reader meets it. */
function closing(outcome: TurnOutcome, asker?: Author): readonly Written[] {
	const entries: Written[] = [];

	// E25: compactions before the answer, because that is when they happened. A
	// compaction is a decision taken part way through the turn about what the model
	// would be shown next, so a reader meeting it after the reply would be reading the
	// turn out of order.
	//
	// Nothing is written when the provider reported none, and nothing is written when it
	// reported an empty list either. The distinction between silence and "I looked" is
	// real and it belongs to the seam; in the record they are the same absence of an
	// event, and an entry saying a compaction did not happen is noise in a chain whose
	// value is that everything in it happened.
	//
	// E80: the calls go in the same pass, because they happened in the same turn. A compaction is
	// taken before the model is asked at its step and the calls come back after, so at one step the
	// compaction comes first. A compaction reported without a step is placed at the start, which is
	// where a provider that counts no steps would have had to take it.
	// E83: the decision before anything else the turn did, because it was taken before the first step. The
	// persona's, like its answer: the route and the reason are what its model said.
	if (outcome.decision !== undefined) {
		entries.push({
			author: answererOf(),
			body: { type: "decision", turn: outcome.turn, route: outcome.decision.route, why: outcome.decision.why },
		});
	}

	const during: { readonly step: number; readonly order: number; readonly written: Written }[] = [];
	for (const compaction of outcome.compactions ?? []) {
		during.push({
			step: compaction.step ?? 0,
			order: 0,
			written: { author: compactionAuthor(compaction.why), body: compactionEntry(compaction.plan, compaction.why) },
		});
	}
	for (const call of outcome.calls ?? []) {
		during.push({ step: call.step, order: 1, written: { author: GATE, body: callEntry(outcome.turn, call) } });
	}
	// `sort` is stable, so entries of one kind at one step keep the order they were reported in.
	during.sort((a, b) => a.step - b.step || a.order - b.order);
	for (const entry of during) entries.push(entry.written);

	// E84: each question the persona put to a person, in its name, and the answer after it in the name of whoever
	// opened the turn, which is who was in front of it. A question with no answer is the one the turn stopped at,
	// and it is written all the same: it is what whoever picks the work up has to find.
	for (const asked of outcome.questions ?? []) {
		entries.push({
			author: answererOf(),
			body: {
				type: "question",
				turn: outcome.turn,
				question: asked.question,
				options: asked.options,
				...(asked.recommended === undefined ? {} : { recommended: asked.recommended }),
			},
		});
		if (asked.answer !== undefined) {
			entries.push({
				author: asker ?? { kind: "runtime", mechanism: "question", reason: "an answer in a turn whose opening was not seen" },
				body: { type: "answer", turn: outcome.turn, question: asked.question, answer: asked.answer },
			});
		}
	}

	// E85: what the runtime checked about what the turn left, before the answer that claims it is done. The
	// runtime's entry and not the persona's: the persona wrote the file, and this is somebody else running it.
	// Written whenever the turn left anything, including when nothing could be checked, because an absence
	// nobody names reads as verified.
	if (outcome.delivered !== undefined && (outcome.delivered.checks.length > 0 || outcome.delivered.unverified.length > 0)) {
		entries.push({
			author: { kind: "runtime", mechanism: "verification", reason: "what was checked about what this turn left" },
			body: {
				type: "verification",
				turn: outcome.turn,
				checks: [...outcome.delivered.checks],
				unverified: outcome.delivered.unverified,
			},
		});
	}

	// E81: the list the turn ended with, once, after the calls that changed it and before the answer.
	// The runtime's entry, not the persona's: the steps are the persona's words, and `verified` is the
	// runtime's judgement of them against the calls that succeeded, which the persona did not write.
	if (outcome.tasks !== undefined && outcome.tasks.length > 0) {
		entries.push({
			author: { kind: "runtime", mechanism: "task-list", reason: "the list the persona kept, checked against the calls that succeeded" },
			body: { type: "tasks", turn: outcome.turn, tasks: outcome.tasks },
		});
	}

	// The answer next, so a reader walking the entries meets what was said before it
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
	// E84: who opened the turn, so an answer given inside it is written in their name.
	let asker: Author | undefined;
	const write = (entries: readonly Written[]): void => {
		for (const entry of entries) journal.append(entry.author, entry.body);
	};

	return {
		opened: (request) => {
			asker = askerOf(request);
			return write(opening(request));
		},
		closed: (outcome) => write(closing(outcome, asker)),
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

	// E84: who opened the turn, so an answer given inside it is written in their name.
	let asker: Author | undefined;
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
		opened: (request) => {
			asker = askerOf(request);
			return write(opening(request));
		},
		closed: (outcome) => write(closing(outcome, asker)),
	};
}
