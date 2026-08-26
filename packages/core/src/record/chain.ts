/**
 * What makes the record something you can hand to somebody who does not trust you.
 *
 * Every entry commits to the one before it, so an edit, a reorder, an insertion or a
 * deletion anywhere in the middle breaks verification from that point on. Append-only
 * by convention is a promise; this is a property.
 *
 * ## Two things the hash covers that a naive one would not
 *
 * The **sequence number** is inside the hash. Without it, swapping two entries that
 * happen to hash identically, which is easy to arrange when they are the same kind of
 * fact with the same author, would leave the chain intact and the order wrong. Order
 * is not decoration here: state is a fold, and a fold over a different order is a
 * different state.
 *
 * The **author** is inside the hash. It is the one field somebody rewriting history
 * would most want to change, because the cheapest forgery is not inventing an event,
 * it is moving one from a component onto a person.
 *
 * ## Canonical bytes, or the chain verifies on one machine and not the next
 *
 * `JSON.stringify` walks a plain object in insertion order, so two entries with the
 * same content and different key order hash differently. That is fine while one
 * process writes and reads them, and it stops being fine the moment an entry crosses
 * a wire, gets parsed by something that normalises key order, or is rebuilt by a
 * different version of the code. Keys are sorted before hashing, so the bytes depend
 * on the content and nothing else.
 */

import { createHash } from "node:crypto";

import type { Author, DraftEntry, RecordEntry } from "./entry.js";

/** Sorts keys at every depth so the bytes depend on content and not on construction. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value === null || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		if (source[key] === undefined) continue;
		out[key] = canonical(source[key]);
	}
	return out;
}

/** The bytes an entry's hash is taken over. Exported so a test can pin them. */
export function digestInput(entry: Omit<RecordEntry, "hash">): string {
	return JSON.stringify(
		canonical({
			seq: entry.seq,
			at: entry.at,
			author: entry.author,
			body: entry.body,
			// Where it was written commits too. Provenance outside the hash is
			// provenance anybody can edit afterwards, which reads as evidence and is
			// not. `canonical` drops undefined keys, so an entry that knows none of it
			// hashes exactly as it did before this existed.
			provenance: entry.provenance,
			prev: entry.prev,
		}),
	);
}

function digest(entry: Omit<RecordEntry, "hash">): string {
	return createHash("sha256").update(digestInput(entry)).digest("hex");
}

/** Chains a draft onto whatever came before it. */
export function chain(draft: DraftEntry, seq: number, prev: string): RecordEntry {
	const unhashed = { ...draft, seq, prev };
	return { ...unhashed, hash: digest(unhashed) };
}

/** Whether an author is well formed. An entry without one is not an entry. */
function authorIsValid(author: Author | undefined): boolean {
	if (!author || typeof author !== "object") return false;
	switch (author.kind) {
		case "human":
		case "persona":
			return typeof author.id === "string" && author.id.length > 0;
		case "component":
			return typeof author.name === "string" && author.name.length > 0;
		case "runtime":
			// The runtime writing something is the case a reader most needs explained,
			// so an empty reason is as bad as no author at all.
			return (
				typeof author.mechanism === "string" &&
				author.mechanism.length > 0 &&
				typeof author.reason === "string" &&
				author.reason.length > 0
			);
		default:
			return false;
	}
}

/** Why a chain did not verify. Each case names itself, none of them is a boolean. */
export type ChainProblem =
	| { readonly kind: "no_author"; readonly seq: number }
	| { readonly kind: "out_of_order"; readonly seq: number; readonly expected: number }
	| { readonly kind: "broken_link"; readonly seq: number }
	| { readonly kind: "altered"; readonly seq: number };

export interface ChainVerdict {
	readonly ok: boolean;
	readonly length: number;
	/** The first problem found. Verification stops there: everything after is suspect. */
	readonly problem?: ChainProblem;
}

/**
 * Checks a whole chain, and stops at the first thing wrong.
 *
 * Stopping is deliberate. Once an entry does not verify, every later link was
 * computed over a value we cannot vouch for, so continuing would produce a list of
 * problems most of which are consequences of the first. One honest answer beats a
 * page of derived noise.
 */
export function verify(entries: readonly RecordEntry[]): ChainVerdict {
	let prev = "";
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (!authorIsValid(entry.author)) {
			return { ok: false, length: index, problem: { kind: "no_author", seq: entry.seq } };
		}
		if (entry.seq !== index) {
			return {
				ok: false,
				length: index,
				problem: { kind: "out_of_order", seq: entry.seq, expected: index },
			};
		}
		if (entry.prev !== prev) {
			return { ok: false, length: index, problem: { kind: "broken_link", seq: entry.seq } };
		}
		if (digest(entry) !== entry.hash) {
			return { ok: false, length: index, problem: { kind: "altered", seq: entry.seq } };
		}
		prev = entry.hash;
	}
	return { ok: true, length: entries.length };
}

/** The hash the next entry has to point at. */
export function head(entries: readonly RecordEntry[]): string {
	return entries.length === 0 ? "" : entries[entries.length - 1]!.hash;
}
