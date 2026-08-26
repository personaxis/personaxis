/**
 * Writing to the record, and getting it to disk without making the turn wait.
 *
 * Two things have to be true at once and they pull in opposite directions. An entry
 * has to be **visible immediately**, because the next line of code derives state from
 * it and a write that has not landed yet is a state that is briefly wrong. And it has
 * to reach storage **without blocking the turn**, because a slow writer that runs
 * inline holds the turn open long after the person saw their answer, and every
 * surface then shows the agent as busy for as long as the writer takes. One of the
 * references measured a misconfigured daemon blocking about 298 seconds that way.
 *
 * So: append is synchronous into memory and returns the chained entry, and
 * persistence happens behind, drained at a control point.
 *
 * ## The drain point is a boundary, not a timer
 *
 * Draining on a clock means the durable prefix ends wherever the clock happened to
 * fall, which is usually in the middle of something. Draining at the close of a turn
 * means whatever survives a crash is a whole number of turns, and a resumed
 * conversation is one a provider will accept.
 *
 * ## A crashed turn is closed, never truncated
 *
 * If the process dies with a turn open, the next load finds an opening with no close.
 * Cutting the tail off would be the easy fix and it produces a transcript that ends
 * mid-exchange, which providers reject. So the turn is **closed with a synthetic
 * entry**, and that entry is written by the runtime and says so. This is exactly the
 * case the author invariant exists for: a close nobody wrote, presented as though the
 * persona had written it, is a forged record.
 *
 * ## What a failing writer may not do
 *
 * Fail silently. A drain that could not write comes back saying so, and the entries
 * stay pending rather than being dropped as though they had landed. The one thing
 * worse than losing an entry is believing you did not.
 */

import { chain, head, verify, type ChainVerdict } from "./chain.js";
import { derive, type DeriveResult } from "./derive.js";
import { ENTRY_VERSION, type Author, type DraftEntry, type Provenance, type RecordBody, type RecordEntry } from "./entry.js";

/** Where entries go when they are drained. Anything durable can be one. */
export interface RecordSink {
	/** Appends, in order. Rejecting means nothing in this batch landed. */
	append(entries: readonly RecordEntry[]): Promise<void>;
}

export interface JournalOptions {
	/** Defaults to the wall clock; injected so a test sees fixed timestamps. */
	now?: () => Date;
	/** Where drained entries go. Without one the journal is memory only. */
	sink?: RecordSink;
	/** Entries recovered from a previous run, in order. */
	initial?: readonly RecordEntry[];
}

/** What a drain did. */
export interface DrainReport {
	readonly written: number;
	readonly pending: number;
	/** Present when the sink refused. The entries are still pending. */
	readonly failure?: { readonly message: string };
}

export class Journal {
	private readonly entries: RecordEntry[] = [];
	private readonly now: () => Date;
	private readonly sink: RecordSink | undefined;
	/** Index of the first entry not yet known to be durable. */
	private durableThrough = 0;
	/** Set while a drain is in flight, so two drains cannot write the same prefix. */
	private draining: Promise<DrainReport> | undefined;

	constructor(options: JournalOptions = {}) {
		this.now = options.now ?? (() => new Date());
		this.sink = options.sink;
		if (options.initial && options.initial.length > 0) {
			this.entries.push(...options.initial);
			// Whatever was recovered is by definition already durable. Counting it as
			// pending would rewrite it on the next drain, which for an append-only sink
			// means duplicating the entire history on every restart.
			this.durableThrough = this.entries.length;
		}
	}

	/** Everything, in order. A copy, because the caller must not be able to edit it. */
	all(): readonly RecordEntry[] {
		return [...this.entries];
	}

	/** The state this record describes right now. */
	state(): DeriveResult {
		return derive(this.entries);
	}

	/** Whether the chain holds. */
	verify(): ChainVerdict {
		return verify(this.entries);
	}

	/** How many entries are written but not yet known to be durable. */
	get pending(): number {
		return this.entries.length - this.durableThrough;
	}

	/**
	 * Write what the fold says right now, so a later reader can start from here.
	 *
	 * Appended like anything else, because it is a fact about the record and belongs
	 * inside the chain it summarises rather than in a file somebody could edit. It is
	 * built from `derive` over everything held, so it is honest by construction rather
	 * than by promise, and `derive` skips checkpoints when folding, so writing one
	 * cannot change what the record means.
	 *
	 * The author is the runtime, which is what wrote it, and nobody asked for it.
	 *
	 * Does nothing when the chain does not verify. A checkpoint over a broken chain
	 * would take a number nobody can vouch for and put it somewhere later readers
	 * treat as established.
	 */
	/** How many entries have been written since the last checkpoint, or since the start. */
	sinceCheckpoint(): number {
		for (let index = this.entries.length - 1; index >= 0; index -= 1) {
			if (this.entries[index]!.body.type === "checkpoint") return this.entries.length - index - 1;
		}
		return this.entries.length;
	}

	checkpoint(): RecordEntry | undefined {
		const folded = derive(this.entries);
		if (!folded.ok) return undefined;

		return this.append(
			{
				kind: "runtime",
				mechanism: "checkpoint",
				reason: `so a reader does not have to fold ${this.entries.length} entries to know where this persona is`,
			},
			{ type: "checkpoint", state: folded.state },
		);
	}

	/**
	 * Takes entries that already exist and are already chained, keeping them as they
	 * are: their moments, their authors, their provenance and their links.
	 *
	 * Not the same operation as appending, and the difference is the whole point. A
	 * migration replaying a persona's history had been going through `append`, which
	 * stamps the clock and takes only an author and a body, so every entry came out
	 * dated the instant of the migration and carrying none of what the row knew about
	 * where it was written. Measured on this repo's persona: 147 rows spanning two
	 * months came back with 147 identical timestamps one millisecond apart. An audit
	 * trail whose dates are all the moment somebody upgraded is not an audit trail.
	 *
	 * Only into an empty journal, because these carry their own sequence numbers and
	 * links from zero. Grafting them onto existing entries would produce two entries
	 * with the same `seq` and a chain that stops verifying at the join.
	 *
	 * They count as pending, unlike `initial`. `initial` came out of the sink and is
	 * already durable; these have never been written to it and the whole purpose of
	 * adopting them is that they will be.
	 */
	adopt(entries: readonly RecordEntry[]): void {
		if (this.entries.length > 0) {
			throw new Error(
				`a record with ${this.entries.length} entries cannot adopt a history: the ` +
					"entries being adopted are chained from zero and would collide with what is here",
			);
		}
		this.entries.push(...entries);
	}

	/**
	 * Writes one entry and returns it, chained.
	 *
	 * Synchronous on purpose: the caller's next line may derive state, and an append
	 * that had not landed yet would make that derivation briefly wrong in a way
	 * nothing would catch.
	 */
	append(author: Author, body: RecordBody, provenance?: Provenance): RecordEntry {
		const draft: DraftEntry = {
			v: ENTRY_VERSION,
			at: this.now().toISOString(),
			author,
			body,
			// Omitted rather than stored empty: an entry that says it came from nowhere
			// and one that never claimed to are different, and only one of them is a
			// gap somebody should close.
			...(provenance === undefined ? {} : { provenance }),
		};
		const entry = chain(draft, this.entries.length, head(this.entries));
		this.entries.push(entry);
		return entry;
	}

	/**
	 * Pushes everything pending to the sink.
	 *
	 * Two drains at once would each read the same pending window and write it twice,
	 * so a second call joins the one in flight rather than starting another. That is
	 * the ordinary case and not an edge: a turn closing while a periodic flush is
	 * already running is exactly what happens under load.
	 */
	async drain(): Promise<DrainReport> {
		if (this.draining) return this.draining;
		const run = this.runDrain();
		this.draining = run;
		try {
			return await run;
		} finally {
			this.draining = undefined;
		}
	}

	private async runDrain(): Promise<DrainReport> {
		if (!this.sink) return { written: 0, pending: this.pending };
		const batch = this.entries.slice(this.durableThrough);
		if (batch.length === 0) return { written: 0, pending: 0 };
		try {
			await this.sink.append(batch);
		} catch (thrown) {
			// The window stays pending. Advancing it here would report success for
			// entries that are nowhere, which is the one failure mode a record cannot
			// have: believing something was written when it was not.
			return {
				written: 0,
				pending: this.pending,
				failure: { message: thrown instanceof Error ? thrown.message : String(thrown) },
			};
		}
		this.durableThrough += batch.length;
		return { written: batch.length, pending: this.pending };
	}

	/**
	 * Closes a turn that never closed itself, and says who did it.
	 *
	 * Called on load, after recovering a record that ends with an open turn. The
	 * synthetic close is what keeps a resumed transcript valid, and the author is what
	 * keeps it honest.
	 *
	 * Returns the entry when one was needed, so a caller can surface that the previous
	 * run did not finish rather than papering over it.
	 */
	closeCrashedTurn(reason: string): RecordEntry | undefined {
		const result = derive(this.entries);
		if (!result.ok || result.state.openTurn === undefined) return undefined;
		return this.append(
			{ kind: "runtime", mechanism: "crash-recovery", reason },
			{
				type: "turn-close",
				turn: result.state.openTurn,
				outcome: "interrupted",
				synthetic: true,
			},
		);
	}
}
