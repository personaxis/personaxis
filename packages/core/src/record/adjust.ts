/**
 * Moving a persona's coordinate, end to end, with the record as the source.
 *
 * The pieces existed and nothing joined them: `store.ts` gives the record a file,
 * `mutate.ts` writes a move into it, `project.ts` prints the state file from it, and
 * `bridge.ts` can turn an existing state file into entries. This is the one path that
 * uses all four, and it is what makes `state.json` a view rather than a second source.
 *
 * ## The migration happens on first touch, and only once
 *
 * A persona that exists today has its history inside `state.json` and an empty record.
 * Asking somebody to run a migration command is asking them to remember, and the ones
 * who forget end up with a record that starts mid-life and an audit that begins with a
 * persona appearing from nowhere.
 *
 * So the first write to an empty record replays what the state file already holds,
 * through the same bridge the equivalence tests use. After that the record is ahead of
 * the file and the replay never runs again, because the record is no longer empty.
 *
 * The replay is not a guess: every row of a `mutation_log` carries its field, its
 * before and after, whether it was clamped and who did it, which is exactly what an
 * entry needs. What it cannot recover is anything the old format never stored, and
 * that is a fact about the old format rather than a loss here.
 *
 * ## The state file is written, and it is still not the source
 *
 * It keeps being written because everything that reads a persona today reads it, and
 * a migration that breaks every reader on the first step is not a migration. What
 * changed is which way the arrow points: it is printed FROM the record, so editing it
 * by hand changes nothing that survives the next write. R8 is what removes it as a
 * thing anybody reads.
 */

import { writeFileSync } from "node:fs";

import type { Envelope } from "../envelopes.js";
import { acquireStateLock } from "../lock.js";
import type { StateFile } from "../persona.js";
import { readState } from "../persona.js";
import { replayStateFile } from "./bridge.js";
import type { Author } from "./entry.js";
import type { Journal } from "./journal.js";
import { mutate, type Decision, type MoveRequest } from "./mutate.js";
import { project, type Identity } from "./project.js";
import { openRecord } from "./store.js";

/** Who this record belongs to, read from the file it is replacing. */
function identityOf(state: StateFile): Identity {
	return {
		schemaVersion: state.schema_version,
		personaId: state.persona_id,
		personaVersion: state.persona_version,
		...(state.session_id === undefined ? {} : { sessionId: state.session_id }),
	};
}

/**
 * Bring a record up to date with a state file it has never seen.
 *
 * Does nothing when the record already has entries, which is what makes this safe to
 * call on every write instead of once behind a flag somebody has to remember.
 */
export function adopt(record: Journal, state: StateFile): void {
	if (record.all().length > 0) return;

	// Handed over whole, not replayed through `append`. Appending re-stamps the clock
	// and takes only an author and a body, so the history came out dated the moment of
	// the migration and stripped of the machine and session each row knew about. On
	// this repo's persona that turned two months into one millisecond.
	record.adopt(replayStateFile(state));
}

/** What a completed adjustment did, and where it left the persona. */
export interface AdjustResult {
	readonly decision: Decision;
	/** The state file as printed from the record, after the move. */
	readonly state: StateFile;
}

/**
 * One move and who is making it.
 *
 * The author travels with the move rather than with the batch, because a tick is not
 * one hand: a decay is the runtime pulling a value toward its baseline and an
 * admitted change is the persona acting. One author for the batch would put the
 * runtime's name on the persona's changes, or the reverse.
 */
export interface Move {
	readonly author: Author;
	readonly request: MoveRequest;
}

/** What a batch did, in the order it did it. */
export interface AdjustAllResult {
	readonly decisions: readonly Decision[];
	/** The state file as printed from the record, after every move in the batch. */
	readonly state: StateFile;
}

/**
 * Move one coordinate and leave both the record and the printed file correct.
 *
 * The drain is awaited rather than left in flight. This is a deliberate difference
 * from a turn, where the whole point of the journal is that the person does not wait
 * for the writer: an adjustment IS the operation somebody asked for, so returning
 * before it is durable would be reporting a change that a crash could take back.
 */
export async function adjust(
	personaPath: string,
	statePath: string,
	envelopes: Record<string, Envelope>,
	author: Author,
	req: MoveRequest,
): Promise<AdjustResult> {
	const { decisions, state } = await adjustAll(personaPath, statePath, envelopes, [
		{ author, request: req },
	]);
	return { decision: decisions[0]!, state };
}

/**
 * Move several coordinates as one transaction.
 *
 * A tick is not a sequence of adjustments. It decays what has drifted and applies
 * what was admitted, and those belong to the same moment: running them one at a time
 * would take the lock, read the file, verify the chain and print the document once
 * per coordinate, and would leave a crash between two of them with a persona that
 * half-ticked. One lock, one verify, one print.
 *
 * The order of `moves` is the order they happen, and it matters: each move reads the
 * value the one before it left, which is what makes clamping compose correctly.
 * Summing deltas first and clamping once at the end is a different and wrong answer,
 * because `clamp(a + b)` is not `clamp(a) + clamp(b)`.
 */
export async function adjustAll(
	personaPath: string,
	statePath: string,
	envelopes: Record<string, Envelope>,
	moves: readonly Move[],
): Promise<AdjustAllResult> {
	// The lock is taken here and released in `finally`, rather than through
	// `withStateLock`. That helper is generic over the callback's return type, so
	// handing it an async function type-checks and releases the lock the moment the
	// promise is CREATED, leaving the read, the write and the print unprotected for
	// exactly as long as they take. A lock that is held only until the first await is
	// worse than none: it looks like protection in the code and provides none.
	const release = acquireStateLock(statePath);
	try {
		return await write(personaPath, statePath, envelopes, moves);
	} finally {
		release();
	}
}

async function write(
	personaPath: string,
	statePath: string,
	envelopes: Record<string, Envelope>,
	moves: readonly Move[],
): Promise<AdjustAllResult> {
	const stored = readState(statePath);
	const record = openRecord(personaPath);
	const migrated = record.all().length === 0;
	adopt(record, stored);

	const decisions = moves.map((move) => mutate(record, envelopes, move.author, move.request));

	const report = await record.drain();
	if (report.failure) {
		throw new Error(
			`the move was decided but could not be recorded (${report.failure.message}), so nothing was written`,
		);
	}

	const folded = record.state();
	if (!folded.ok) {
		// Named with the entry, because "the chain is broken" without a sequence number
		// sends somebody through the whole file. The chain stops at the first problem
		// on purpose: everything after it is suspect, so reporting the first is
		// reporting the only one that can be trusted to be real.
		throw new Error(
			`the record does not verify after the move: ${folded.problem.kind} at entry ${folded.problem.seq}`,
		);
	}

	const printed = project(folded.state, record.all(), identityOf(stored));
	// Written when anything actually changed. A batch with no moves against a record
	// that already existed is a tick where nothing happened, and rewriting the file
	// then would touch its mtime on every idle turn for no reason. A first touch is a
	// change even with no moves: it is the migration.
	if (migrated || moves.length > 0) {
		writeFileSync(statePath, JSON.stringify(printed, null, 2) + "\n", "utf-8");
	}

	return { decisions, state: printed };
}
