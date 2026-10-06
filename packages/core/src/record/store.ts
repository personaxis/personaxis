/**
 * The record on disk, for one persona.
 *
 * M1 proved the state file can be PRINTED from the record. This is the other half:
 * somewhere for the record to live, so the engine can write there instead of into
 * `state.json`. Until both halves exist there are two chains over one history, the
 * `mutation_log` inside the state file and the record, and two chains over the same
 * facts can disagree with nothing to say which is right.
 *
 * ## Why a file of lines and not a document
 *
 * The record is append-only and hash-chained, and both properties are cheap in a file
 * of lines and expensive in a JSON document. Appending a line is one write at the end;
 * appending to an array means reading the whole thing, parsing it, pushing, serialising
 * and rewriting, which is four chances to lose the file and a window where a reader
 * sees half a document.
 *
 * It also fails better. A truncated last line is one unreadable entry, and the chain
 * says exactly where it stops. A truncated JSON document is nothing at all.
 *
 * ## Reading refuses rather than repairs
 *
 * A line that does not parse is not skipped. Skipping would silently shorten the
 * history and every hash after it would still verify against a chain that is missing a
 * link, which is a record that lies with a clean bill of health. So a damaged line
 * stops the read and names the line number, and whoever looks decides.
 *
 * The one exception is a trailing partial line, which is what a crash mid-append
 * leaves. That is not damage in the middle, it is an entry that never finished being
 * written, and dropping it puts the file back exactly where the last completed append
 * left it.
 *
 * ## Writing refuses a batch chained onto a head the file has moved past
 *
 * A `Journal` chains its entries onto the head it held when it opened. Nothing stops a
 * second journal opening on the same record, writing, and leaving the first holding a
 * head that is no longer the file's. The first one's next append then carries a
 * sequence number the file already used and a link to an entry that is no longer last.
 *
 * Measured before this existed, with two journals over one record: three entries on
 * disk numbered 0, 1, 1, and the chain stopping at the second of them. Nothing threw.
 * The corruption is written by the ordinary path, it is durable, and it is found by
 * whoever verifies next rather than by whoever caused it.
 *
 * "Open the record, write, drain, let go" is the discipline that avoids it, and a
 * discipline is a rule that holds until somebody is in a hurry. So the file refuses
 * instead: an append has to continue the file as it stands at that moment, or none of
 * the batch lands and the journal is told, which is the contract it already had for a
 * sink that would not take a write.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { chain, head, holds } from "./chain.js";
import { derive, deriveFrom, emptyState, type DeriveResult, type DerivedState } from "./derive.js";
import type { DraftEntry, RecordEntry } from "./entry.js";
import { Journal, type RecordSink } from "./journal.js";

/** Where a persona's record lives: beside its spec, like its state file. */
export function recordPathFor(personaPath: string): string {
	return join(dirname(personaPath), "record.jsonl");
}

/** What went wrong reading a record, with the line so somebody can go and look. */
export class RecordDamaged extends Error {
	constructor(
		readonly path: string,
		readonly line: number,
		cause: string,
	) {
		super(`${path}:${line} could not be read as a record entry (${cause}). Nothing was skipped.`);
		this.name = "RecordDamaged";
	}
}

/**
 * Every entry in a record file, in order.
 *
 * A missing file is an empty record, not an error: a persona that has never moved has
 * nothing to say, and that is different from a persona whose record could not be read.
 */
export function readRecord(path: string): RecordEntry[] {
	if (!existsSync(path)) return [];

	const raw = readFileSync(path, "utf-8");
	if (raw.length === 0) return [];

	// The last piece of the split is dropped either way, and the two reasons are
	// different, which is why this is a comment rather than a branch that looks like it
	// decides something. A file written by appends ends in a newline, so the last piece
	// is empty. A file that does not end in one was cut mid-append, so the last piece is
	// an entry that never finished being written. Dropping it puts the file back exactly
	// where the last completed append left it.
	const complete = raw.split("\n").slice(0, -1);

	const entries: RecordEntry[] = [];
	for (const [index, line] of complete.entries()) {
		if (line.trim().length === 0) continue;
		try {
			entries.push(JSON.parse(line) as RecordEntry);
		} catch (error) {
			throw new RecordDamaged(path, index + 1, (error as Error).message);
		}
	}
	return entries;
}

/**
 * A sink that appends lines to a file.
 *
 * Synchronous inside an async signature, deliberately. `appendFileSync` on a single
 * open-append-close is atomic enough for lines under the pipe buffer, which every
 * entry is, and it cannot interleave with itself the way two async writes can. The
 * journal already keeps the turn from waiting on this, so there is nothing to gain
 * from making the write itself asynchronous and a real interleaving hazard to lose.
 */
function appendLines(path: string, entries: readonly RecordEntry[]): void {
	if (entries.length === 0) return;
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
}

/**
 * The last complete entry in a record file, without reading the rest of it.
 *
 * Read backwards from the end until a newline turns up, because the only thing a
 * writer needs to know is where the file currently ends. Reading forwards to find the
 * last of something means reading everything, and this runs on every append.
 *
 * `undefined` for a file that is missing, empty, or whose only line never finished
 * being written. All three mean the same thing to a writer: there is nothing here to
 * continue from.
 */
function lastEntry(path: string, blockSize = 8 * 1024): RecordEntry | undefined {
	if (!existsSync(path)) return undefined;
	const size = statSync(path).size;
	if (size === 0) return undefined;

	const handle = openSync(path, "r");
	try {
		let end = size;
		let carried = "";
		while (end > 0) {
			const start = Math.max(0, end - blockSize);
			const block = Buffer.alloc(end - start);
			readSync(handle, block, 0, block.length, start);
			carried = block.toString("utf-8") + carried;
			end = start;

			// The trailing piece is dropped for the same two reasons `readRecord` drops
			// it: a file written by appends ends in a newline, and one that does not was
			// cut mid-append and its last piece is an entry that never landed.
			const lines = carried.split("\n").slice(0, -1);
			const complete = lines.filter((line) => line.trim().length > 0);
			// Only usable once the line is known to be whole, which it is when a newline
			// precedes it or the block reached the start of the file.
			if (complete.length > (end === 0 ? 0 : 1)) {
				try {
					return JSON.parse(complete[complete.length - 1]!) as RecordEntry;
				} catch {
					// Damage, and `readRecord` is what reports it with the real line number.
					// Saying nothing here sends the writer down the refusal path, which is the
					// safe direction: a record nobody can read is not one to append to.
					return undefined;
				}
			}
		}
	} finally {
		closeSync(handle);
	}
	return undefined;
}

/** How a refused append reads, naming both views so the divergence is legible. */
function staleWrite(path: string, seq: number, found: RecordEntry | undefined): string {
	const here = found === undefined ? "the record is empty" : `the record ends at entry ${found.seq}`;

	return (
		`${path}: this batch was chained onto entry ${seq - 1} and ${here}, so it ` +
		"was written from a view of the record that has since moved. Nothing was appended. " +
		"Open the record again and write from where it is now."
	);
}

export function fileSink(path: string): RecordSink {
	return {
		async append(entries) {
			const first = entries[0];
			if (first === undefined) return;

			// The whole batch is chained, so checking the first entry checks all of them:
			// if it continues the file, every later one continues its predecessor by
			// construction.
			const last = lastEntry(path);
			const continues =
				last === undefined
					? first.seq === 0 && first.prev === ""
					: first.seq === last.seq + 1 && first.prev === last.hash;
			if (!continues) throw new Error(staleWrite(path, first.seq, last));

			appendLines(path, entries);
		},
	};
}

/** A record read from its last checkpoint onward, and where that point is. */
export interface Tail {
	/** The state the checkpoint established, or the empty state when there is none. */
	readonly start: DerivedState;
	/** Everything after the checkpoint, in order. */
	readonly entries: RecordEntry[];
	/** Where the tail begins, so its chain can be checked from the right place. */
	readonly from: { seq: number; prev: string };
	/** Whether a checkpoint was found at all. False means this is the whole record. */
	readonly checkpointed: boolean;
}

/**
 * Read only what a reader needs: the last checkpoint and everything after it.
 *
 * The file is read backwards in blocks and stopped at the first checkpoint found from
 * the end, so a persona with a long history costs what its recent history costs
 * instead of what its whole history costs. Folding the whole record is 238ms at
 * 50,000 entries and only ever grows; this is flat in the size of the file behind the
 * checkpoint.
 *
 * A record with no checkpoint reads whole, which is the honest fallback and the one
 * every existing record takes.
 */
export function readTail(path: string, blockSize = 64 * 1024): Tail {
	const whole = (): Tail => ({
		start: emptyState(),
		entries: readRecord(path),
		from: { seq: 0, prev: "" },
		checkpointed: false,
	});

	if (!existsSync(path)) return whole();
	const size = statSync(path).size;
	if (size === 0) return whole();

	const handle = openSync(path, "r");
	try {
		// Backwards in blocks, keeping what has been read so a checkpoint found in an
		// earlier block still has every line after it. Reading forwards to find the
		// LAST of something means reading everything, which is the cost being avoided.
		let end = size;
		let carried = "";
		while (end > 0) {
			const start = Math.max(0, end - blockSize);
			const block = Buffer.alloc(end - start);
			readSync(handle, block, 0, block.length, start);
			carried = block.toString("utf-8") + carried;
			end = start;

			// The first line of the block may be a fragment unless the block starts at
			// the beginning of the file, so it is left for the next iteration to
			// complete. Parsing a fragment would report damage that is not there.
			const newline = carried.indexOf("\n");
			const usable = end === 0 ? carried : carried.slice(newline + 1);
			const found = lastCheckpoint(usable, path);
			if (found) return found;
			if (end === 0) break;
		}
	} finally {
		closeSync(handle);
	}

	return whole();
}

/** The last checkpoint in a block of complete lines, with everything after it. */
function lastCheckpoint(block: string, path: string): Tail | undefined {
	const lines = block.split("\n").filter((line) => line.trim().length > 0);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		let entry: RecordEntry;
		try {
			entry = JSON.parse(lines[index]!) as RecordEntry;
		} catch {
			// A line that will not parse is damage, and reporting it from here would
			// name a line number counted from the wrong place. `readRecord` is what
			// reports damage, with the real line, and falling through reaches it.
			return undefined;
		}
		if (entry.body?.type !== "checkpoint") continue;

		// The one entry this read takes on trust, so it is the one entry that must not
		// be taken on trust. Its stored hash is what the tail chains onto, and a
		// checkpoint whose body somebody rewrote would hand the reader a persona that
		// never existed. Recomputing it is one hash and it closes that.
		//
		// It does not prove what came BEFORE the checkpoint: that needs the whole
		// chain, which is exactly the cost this read exists to avoid, and which
		// `derive` over everything still pays when proof rather than speed is wanted.
		// Ignoring a checkpoint that does not hold up sends the read down the whole
		// record, where the tampering is reported properly.
		if (!holds(entry)) return undefined;

		const after: RecordEntry[] = [];
		for (const line of lines.slice(index + 1)) {
			try {
				after.push(JSON.parse(line) as RecordEntry);
			} catch {
				return undefined;
			}
		}
		return {
			start: entry.body.state,
			entries: after,
			from: { seq: entry.seq + 1, prev: entry.hash },
			checkpointed: true,
		};
	}
	return undefined;
}

/**
 * Write a persona's first entries, synchronously, and only into an empty record.
 *
 * Synchronous because the only caller is the one that seeds a persona on first touch,
 * which is itself synchronous and has everything else waiting on it. It writes to the
 * file beside the persona rather than through a store, for the same reason that caller
 * writes `state.json` with the filesystem: seeding is the local path, and a hosted
 * engine seeds through its own.
 *
 * Refuses a record that already has entries. These are chained from zero, so grafting
 * them on would produce two entries with the same sequence number and a chain that
 * stops verifying at the join.
 */
export function seedRecord(personaPath: string, entries: readonly DraftEntry[]): RecordEntry[] {
	const path = recordPathFor(personaPath);
	if (readRecord(path).length > 0) {
		throw new Error(`the record at ${path} is not empty, so it cannot be seeded`);
	}

	const chained: RecordEntry[] = [];
	for (const draft of entries) chained.push(chain(draft, chained.length, head(chained)));
	appendLines(path, chained);
	return chained;
}

/**
 * Where a record's entries are read from and written to.
 *
 * Declared here rather than only in `ports/`, because this is the module that knows
 * what a record needs, and a second declaration over there is a second thing that can
 * drift from it. `key` is the persona's path, as everywhere else: a folder for the
 * filesystem, a row for a database, the store's business either way.
 */
export interface RecordStorage {
	/** Everything already written, in order. Empty for a persona with no record. */
	read(key: string): RecordEntry[];
	/** Where new entries go. Rejecting means none of the batch landed. */
	sink(key: string): RecordSink;
}

/** Entries in a file beside the persona. The default, and not the only possibility. */
export const fileRecordStorage: RecordStorage = {
	read: (key) => readRecord(recordPathFor(key)),
	sink: (key) => fileSink(recordPathFor(key)),
};

/**
 * The record for a persona, loaded and ready to be written to.
 *
 * What was already stored comes back as `initial`, which the journal counts as
 * durable. Counting it as pending would rewrite the whole history on the next drain,
 * and for an append-only store that means the history twice.
 *
 * `storage` is what lets a hosted engine keep entries somewhere that is not a disk.
 * It defaults to the file beside the persona, so a caller written before this existed
 * keeps exactly the behaviour it had.
 */
export function openRecord(
	personaPath: string,
	options: { now?: () => Date; storage?: RecordStorage } = {},
): Journal {
	const storage = options.storage ?? fileRecordStorage;

	return new Journal({
		initial: storage.read(personaPath),
		sink: storage.sink(personaPath),
		...(options.now === undefined ? {} : { now: options.now }),
	});
}

/**
 * Where a persona is, folded from as little of its record as correctness allows.
 *
 * The tail from the last checkpoint, or the whole record when there is none. This is
 * the read that answers "what is this persona now"; `derive` over everything is the
 * read that answers "and prove it", and the two are deliberately different calls
 * because they are different questions with different prices.
 */
export function stateFrom(path: string): DeriveResult {
	const tail = readTail(path);
	if (!tail.checkpointed) return derive(tail.entries);

	return deriveFrom(tail.start, tail.entries, tail.from);
}
