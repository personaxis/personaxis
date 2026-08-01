/**
 * The record: what happened, sealed so that a later edit is detectable.
 *
 * Every action, block, approval, intervention and state change goes in, append
 * only and hash chained. It is the product's evidence, and a customer being
 * able to check it themselves is worth more than a paragraph claiming it is
 * tamper evident, so `verify` is written to be exposed as a button.
 *
 * The chain is per job, not global. Tamper detection only needs ordering within
 * a session, and a global chain would serialise every write in the system to
 * buy nothing.
 *
 * Retention complicates this and is handled head on: expiry removes the payload
 * and keeps the hash of what it was, so the chain still verifies end to end
 * while the content is gone. Deleting whole entries would break verification
 * for everything after them, which is why it never happens.
 */

import { createHash } from "node:crypto";

export interface RecordEntryInput {
	job_id: string;
	seq: number;
	kind: string;
	/** "persona", a user id, or "system". Who caused this. */
	actor: string;
	payload: unknown;
}

export interface RecordEntry extends RecordEntryInput {
	prev_hash: string;
	hash: string;
	/**
	 * Set when the payload has been expired by retention. Holds
	 * "expired:<sha256 of the canonical payload>", so the chain can still be
	 * recomputed without the content.
	 */
	payload_key?: string;
}

/** The first link. Ties a chain to its job so two chains cannot be spliced. */
export function genesisHash(jobId: string): string {
	return `genesis:${jobId}`;
}

/**
 * Canonical JSON, RFC 8785.
 *
 * Verification recomputes a hash from data that has been through a database and
 * a JSON parser, so the serialisation has to be stable across both or the chain
 * breaks on entries nobody touched. Key order is sorted, and everything else
 * follows JSON.stringify, which already emits the shortest round-tripping form
 * for numbers and escapes strings per the spec.
 */
export function canonicalise(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;

	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		// Sorted by code unit, which is what RFC 8785 specifies and what
		// JavaScript's default comparison already does for strings.
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(",")}}`;
}

/** The content hash of one entry, before it is chained. */
export function contentHash(entry: RecordEntryInput): string {
	return createHash("sha256")
		.update(
			canonicalise({
				job_id: entry.job_id,
				seq: entry.seq,
				kind: entry.kind,
				actor: entry.actor,
				payload: entry.payload,
			}),
		)
		.digest("hex");
}

/** Seals an entry against the one before it. */
export function seal(entry: RecordEntryInput, prevHash: string): RecordEntry {
	const hash = createHash("sha256").update(prevHash).update(contentHash(entry)).digest("hex");
	return { ...entry, prev_hash: prevHash, hash };
}

/**
 * Expires a payload, keeping the chain intact.
 *
 * The hash of the content is stored rather than recomputed later, because after
 * this the content is gone and there is nothing left to recompute from. The
 * entry's own hash never changes.
 */
export function expirePayload(entry: RecordEntry): RecordEntry {
	const stored = entry.payload_key ?? `expired:${contentHash(entry)}`;
	return { ...entry, payload: null, payload_key: stored };
}

export type VerifyResult =
	| { ok: true; entries: number }
	| { ok: false; first_broken_seq: number; reason: string };

/**
 * Walks a chain and recomputes it.
 *
 * Reports the first sequence number that does not add up rather than a bare
 * false, because localising tampering is the difference between a useful answer
 * and an alarm.
 */
export function verifyChain(jobId: string, entries: readonly RecordEntry[]): VerifyResult {
	const ordered = [...entries].sort((a, b) => a.seq - b.seq);
	let expectedPrev = genesisHash(jobId);
	let expectedSeq = 1;

	for (const entry of ordered) {
		if (entry.seq !== expectedSeq) {
			// A missing entry shows up here, at the sequence that should have
			// been next. Deleting a row does not hide it; it moves the break.
			return {
				ok: false,
				first_broken_seq: expectedSeq,
				reason: `expected seq ${expectedSeq}, found ${entry.seq}`,
			};
		}

		if (entry.prev_hash !== expectedPrev) {
			return {
				ok: false,
				first_broken_seq: entry.seq,
				reason: "previous hash does not match the entry before it",
			};
		}

		// An expired payload cannot be recomputed, so the stored content hash
		// stands in for it. That is the whole reason it is stored.
		const content = entry.payload_key?.startsWith("expired:")
			? entry.payload_key.slice("expired:".length)
			: contentHash(entry);

		const recomputed = createHash("sha256").update(entry.prev_hash).update(content).digest("hex");
		if (recomputed !== entry.hash) {
			return {
				ok: false,
				first_broken_seq: entry.seq,
				reason: "entry hash does not match its contents",
			};
		}

		expectedPrev = entry.hash;
		expectedSeq += 1;
	}

	return { ok: true, entries: ordered.length };
}

/**
 * Appends to a chain, returning the sealed entry.
 *
 * The caller supplies the previous entry rather than a store, so this stays
 * pure and the single writer (the JobRoom) keeps ownership of ordering.
 */
export function appendEntry(
	jobId: string,
	previous: RecordEntry | null,
	entry: Omit<RecordEntryInput, "job_id" | "seq">,
): RecordEntry {
	const seq = previous ? previous.seq + 1 : 1;
	const prevHash = previous ? previous.hash : genesisHash(jobId);
	return seal({ ...entry, job_id: jobId, seq }, prevHash);
}
