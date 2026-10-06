/**
 * The one way to write to a persona's record.
 *
 * `adjustAll` had this written out by hand, and it was correct: take the lock, open
 * the record, check that what is already there verifies, write, drain, let go. Every
 * clause of it was paid for by a bug. Nothing said it was a shape rather than that
 * function's business, so the next writer would have started from `openRecord` and
 * discovered each clause again.
 *
 * The next writer is the turn observer, and it would have got the worst one wrong.
 *
 * ## Why a journal is opened and dropped rather than held
 *
 * A `Journal` chains its entries onto the head it had when it opened. Holding one
 * across a turn, while the living loop writes moves into the same record through its
 * own, means the held one's next append carries a sequence number the file already
 * used. Measured: three entries on disk numbered 0, 1, 1, and the chain stopping at
 * the second of them, written by the ordinary path with nothing thrown.
 *
 * The file refuses that write now, so the failure is loud instead of durable. This is
 * the other half: opening for each write means the refusal never comes up, because
 * every batch is chained onto the head the file actually has.
 *
 * ## Why the lock is the state file's
 *
 * Because that is the one every other writer already takes. `adjustAll` takes it,
 * `ensureState` takes it, and the agent takes it when it persists a run. It is the
 * persona's write lock and has been since before the record existed; keying a second
 * lock on the record file would produce two locks that serialise their own callers and
 * not each other, which is the same as having none.
 *
 * ## Checkpointing happens where the folding already happened
 *
 * Not on a timer. A timer's checkpoint lands wherever the clock fell, which is usually
 * in the middle of nothing; here it lands after a write, by the caller that was
 * already holding the lock and had already folded. Reading a persona means folding its
 * record, and the record only grows: 167 entries fold in about a millisecond and
 * 50,000 in 238ms, on a file nothing ever shortens.
 *
 * Turns are what make that matter. A coordinate moves a handful of times a day and a
 * conversation writes three entries a turn, so once turns are recorded the checkpoint
 * is what keeps reading flat.
 *
 * ## The migration belongs to the first write, whichever write that is
 *
 * A persona that existed before the record has its history inside `state.json` and an
 * empty record, and the first write replays it. That used to live in `adjustAll`, which
 * was fine while moving a coordinate was the only way to write. It stopped being fine
 * here: a turn written into an empty record becomes entry zero, and `Journal.adopt`
 * only takes a history into a record with nothing in it. The next adjustment would have
 * skipped the migration silently and the persona's whole past would have stayed in a
 * file the record had already overtaken.
 *
 * So it happens here, where every writer passes, which is what its own comment always
 * claimed: safe to call on every write instead of once behind a flag somebody has to
 * remember.
 */

import { acquireStateLock } from "../lock.js";
import { readState, stateExists, type StateFile } from "../persona.js";
import { replayStateFile } from "./bridge.js";
import type { ChainProblem } from "./chain.js";
import { ENTRY_VERSION } from "./entry.js";
import type { Journal } from "./journal.js";
import { openRecord, recordPathFor, type RecordStorage } from "./store.js";

/**
 * How many entries may pile up before one summarises them.
 *
 * Small enough that a reader starting from the last one has little left to fold, and
 * large enough that checkpoints are a rounding error in the file rather than a third
 * of it. At this size a checkpoint costs roughly one entry per two hundred.
 */
export const CHECKPOINT_EVERY = 200;

/**
 * What a refusal to read a record should tell somebody, and what to do about it.
 *
 * `unknown_shape` is the one that needs saying out loud, because it is the only case
 * where nothing is wrong with the record. Reported as a bare problem name beside the
 * others, it reads as damage, and somebody goes looking for tampering that did not
 * happen at the exact moment they most need to trust the chain.
 */
export function explain(personaPath: string, problem: ChainProblem): string {
	if (problem.kind === "unknown_shape") {
		return (
			`the record at ${recordPathFor(personaPath)} was written in shape ${problem.found} ` +
			`and this build writes shape ${ENTRY_VERSION} (entry ${problem.seq}). Nothing is wrong ` +
			"with it: this build cannot read it, which is a different thing. Use a build that " +
			"can, or start a new record from the state file."
		);
	}
	return `the record does not verify: ${problem.kind} at entry ${problem.seq}`;
}

/**
 * Where a write reads and writes, for an engine that is not running on a disk.
 *
 * The lock is acquire-and-release rather than the `withLock(key, fn)` shape the other
 * ports use, and that is not a style choice. `withLock` is generic over what the
 * callback returns, so handing it an async function type-checks and releases the lock
 * the moment the promise is CREATED, leaving everything after the first await
 * unprotected. A lock held only until the first await looks like protection in the
 * code and is none.
 */
export interface RecordPorts {
	readonly record?: RecordStorage;
	readonly lock?: (key: string) => () => void;
	/**
	 * How the state file is read and written, for an engine that is not on a disk.
	 *
	 * Read here only for the migration on first touch. Which writers also PRINT the file
	 * is their own business, and today only the one that moves a coordinate does.
	 */
	readonly state?: {
		read(key: string): StateFile;
		write(key: string, state: StateFile): void;
	};
}

/**
 * Bring an empty record up to date with the state file it is replacing.
 *
 * Handed over whole, not replayed through `append`. Appending re-stamps the clock and
 * takes only an author and a body, so the history came out dated the moment of the
 * migration and stripped of the machine and session each row knew about. On this repo's
 * persona that turned two months into one millisecond.
 *
 * A persona with no state file has no history to adopt, which is the ordinary case for
 * one created after the record existed, and is not an error.
 */
function adoptStateFile(record: Journal, statePath: string, ports: RecordPorts): void {
	if (ports.state === undefined && !stateExists(statePath)) return;
	const stored = (ports.state?.read ?? readState)(statePath);
	record.adopt(replayStateFile(stored));
}

/**
 * Write to a persona's record, under the lock, and know it landed.
 *
 * The body is handed an open record and may read it, fold it and append to it. What it
 * returns comes back, so a caller that needs the state afterwards computes it inside,
 * while the lock is still held and the entries it just wrote are still the newest.
 *
 * The drain is awaited rather than left in flight, and a drain that failed throws
 * rather than returning quietly. The one thing worse than losing an entry is believing
 * you did not.
 *
 * @param lockPath the persona's write lock, which is its state file's path
 */
export async function writingToRecord<T>(
	personaPath: string,
	lockPath: string,
	ports: RecordPorts,
	body: (record: Journal, firstTouch: boolean) => T,
): Promise<T> {
	const release = (ports.lock ?? acquireStateLock)(lockPath);
	try {
		const record = openRecord(personaPath, ports.record === undefined ? {} : { storage: ports.record });

		// Checked before anything is added to it. Appending to a chain nobody has
		// verified is appending to something we cannot vouch for, and the check used to
		// run after the drain: an unreadable record received the new entry, the entry
		// reached the disk, and only then did it throw. The record was left worse than
		// it was found.
		const loaded = record.verify();
		if (!loaded.ok) throw new Error(explain(personaPath, loaded.problem!));

		// Before the body, so whatever it writes lands after the history rather than in
		// front of it, and so a turn can never be the entry that closes the record to its
		// own past.
		const firstTouch = record.all().length === 0;
		if (firstTouch) adoptStateFile(record, lockPath, ports);

		const before = record.all().length;
		const result = body(record, firstTouch);

		// Only when something was actually written. A checkpoint over a record nothing
		// added to summarises the same entries the last one did.
		if (record.all().length > before && record.sinceCheckpoint() >= CHECKPOINT_EVERY) {
			record.checkpoint();
		}

		const report = await record.drain();
		if (report.failure) {
			throw new Error(
				`the record could not be written (${report.failure.message}), so nothing was written`,
			);
		}

		return result;
	} finally {
		release();
	}
}
