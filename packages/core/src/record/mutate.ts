/**
 * Moving a coordinate, written to the record instead of into the state file.
 *
 * The old path did three things in one function: it decided where the value should
 * land, it pushed an entry onto a log inside `state.json`, and it maintained a second
 * hash chain over that log. The middle one is what made the state file a source
 * instead of a view, and the third is what made two chains exist over one history.
 *
 * Split here, because the three have nothing to do with each other:
 *
 *   `decide()`  is arithmetic. No clock, no file, no chain, and testable as such.
 *   `mutate()`  writes one entry to the record and returns what it decided.
 *   printing    is `project()`, which already existed and is nobody's business here.
 *
 * ## What the clamp is for, since the split makes it easy to misread
 *
 * An envelope is not a preference. It is the declared range a persona may move within
 * and still be that persona, so a request that would leave it is not refused, it is
 * **clamped and recorded as clamped**. Refusing would lose the fact that something
 * tried; clamping silently would let a reader believe the persona moved where it was
 * asked to. Both matter, and only recording both keeps the difference.
 *
 * `blocked` is the other case and it is not the same thing. A governance-blocked
 * coordinate does not move at all, and the entry says so, so an audit can tell "it
 * went as far as it was allowed" from "it was not allowed to go".
 */

import type { Envelope } from "../envelopes.js";
import { describeAuthor, isWritableAuthor } from "./actor.js";
import { GENESIS, type Author } from "./entry.js";
import { derive } from "./derive.js";
import type { Journal } from "./journal.js";

/** What somebody is asking a coordinate to do. */
export interface MoveRequest {
	readonly field: string;
	readonly delta: number;
	readonly reason: string;
	/** Governance said this coordinate may not move. It is recorded, not skipped. */
	readonly blocked?: boolean;
}

/** Where the value lands, and what happened on the way. */
export interface Decision {
	readonly from: number;
	readonly to: number;
	/** The value asked for, before the envelope had its say. */
	readonly requested: number;
	readonly clamped: boolean;
	readonly blocked: boolean;
}

/**
 * Where a value lands. Pure: same inputs, same answer, no clock and no file.
 *
 * `current` is passed in rather than read, because the caller knows where it keeps
 * state and this does not. That is what lets the same arithmetic serve the record, a
 * dry run, and a test with no persona at all.
 */
export function decide(current: number, envelope: Envelope, req: MoveRequest): Decision {
	if (!Number.isFinite(req.delta)) {
		throw new Error(`Invalid delta for '${req.field}': ${req.delta}`);
	}

	const requested = current + req.delta;
	const inside = Math.max(envelope.min, Math.min(envelope.max, requested));
	const blocked = req.blocked === true;

	return {
		from: current,
		to: blocked ? current : inside,
		requested,
		// A blocked coordinate is not "clamped": it never got as far as the envelope.
		// Reporting both would make an audit read one refusal as two.
		clamped: !blocked && inside !== requested,
		blocked,
	};
}

/**
 * The value a coordinate has right now, according to the record.
 *
 * Falls back to the envelope's declared mean, which is the persona's starting
 * position rather than a default: a coordinate that has never moved is exactly where
 * its spec put it.
 */
export function currentValue(record: Journal, field: string, envelope: Envelope): number {
	const state = record.state();
	if (!state.ok) return envelope.mean;

	return state.state.values[field] ?? envelope.mean;
}

/**
 * Move a coordinate and write it to the record.
 *
 * Returns the decision rather than the entry, because a caller wants to know what
 * happened to the value and the entry is the record's business. The entry is in the
 * journal either way, and the state file is printed from it.
 */
export function mutate(
	record: Journal,
	envelopes: Record<string, Envelope>,
	author: Author,
	req: MoveRequest,
): Decision {
	const envelope = envelopes[req.field];
	if (!envelope) {
		throw new Error(
			`No envelope declared for '${req.field}'. Mutable fields: ${Object.keys(envelopes).join(", ")}`,
		);
	}

	// Refused here rather than when the file is printed. `state.json` has one word
	// for the author and a closed list of five to choose from, so an author outside
	// that list produces an entry nothing can print. Catching it at the print would
	// leave a persona whose record already holds one unable to write its state file
	// ever again; catching it at the write means the mistake is reported to whoever
	// made it, before anything is durable. R8 removes the file and this with it.
	if (!isWritableAuthor(author)) {
		throw new Error(
			`${describeAuthor(author)} cannot be written to a coordinate entry while state.json ` +
				"is still projected from the record: the file's actor vocabulary has no word for it. " +
				"Use one of the mechanisms in MECHANISM, or a human or persona author.",
		);
	}

	const decision = decide(currentValue(record, req.field, envelope), envelope, req);

	record.append(author, {
		type: "value",
		field: req.field,
		from: decision.from,
		to: decision.to,
		requested: decision.requested,
		clamped: decision.clamped,
		blocked: decision.blocked,
		reason: req.reason,
	});

	return decision;
}

/**
 * Write a coordinate's starting position, once.
 *
 * Separate from `mutate` and stamped as genesis, because a persona's declared
 * position is not something that happened to it. An origin recorded as a change makes
 * every audit start with a movement nobody made, and it makes the first real change
 * look like the second.
 */
export function origin(record: Journal, field: string, value: number): void {
	const already = derive(record.all());
	if (already.ok && field in already.state.values) return;

	record.append(
		{ kind: "runtime", mechanism: GENESIS, reason: "the position its spec declares" },
		{
			type: "value",
			field,
			from: value,
			to: value,
			requested: value,
			clamped: false,
			blocked: false,
			reason: "declared",
		},
	);
}
