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
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RecordEntry } from "./entry.js";
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
export function fileSink(path: string): RecordSink {
	return {
		async append(entries) {
			if (entries.length === 0) return;
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
		},
	};
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
