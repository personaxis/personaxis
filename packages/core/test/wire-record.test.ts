import { describe, expect, it } from "vitest";

import {
	appendEntry,
	canonicalise,
	contentHash,
	expirePayload,
	genesisHash,
	verifyChain,
	type RecordEntry,
} from "../src/wire/record.js";

const JOB = "job_1";

function chainOf(count: number): RecordEntry[] {
	const entries: RecordEntry[] = [];
	let previous: RecordEntry | null = null;
	for (let i = 1; i <= count; i++) {
		previous = appendEntry(JOB, previous, {
			kind: "tool.call.completed",
			actor: "persona",
			payload: { step: i, output: `result ${i}` },
		});
		entries.push(previous);
	}
	return entries;
}

describe("a sealed chain", () => {
	it("verifies", () => {
		expect(verifyChain(JOB, chainOf(5))).toEqual({ ok: true, entries: 5 });
	});

	it("starts from a genesis tied to its job, so two chains cannot be spliced", () => {
		const [first] = chainOf(1);
		expect(first.prev_hash).toBe(genesisHash(JOB));
		expect(verifyChain("another_job", [first]).ok).toBe(false);
	});

	it("numbers from one, without gaps", () => {
		expect(chainOf(3).map((e) => e.seq)).toEqual([1, 2, 3]);
	});

	it("verifies regardless of the order rows come back in", () => {
		// A database returns rows in whatever order it likes unless told
		// otherwise, and a chain that only verified when sorted upstream would
		// break for reasons that have nothing to do with tampering.
		const shuffled = [...chainOf(4)].reverse();
		expect(verifyChain(JOB, shuffled).ok).toBe(true);
	});
});

describe("tampering", () => {
	it("names the exact entry whose payload was changed", () => {
		const entries = chainOf(5);
		entries[2] = { ...entries[2], payload: { step: 3, output: "edited" } };

		expect(verifyChain(JOB, entries)).toMatchObject({ ok: false, first_broken_seq: 3 });
	});

	it("names the gap when an entry is deleted", () => {
		// Removing a row does not hide it. The break moves to where it should
		// have been, which is the sequence after the one before it.
		const entries = chainOf(5).filter((e) => e.seq !== 3);
		expect(verifyChain(JOB, entries)).toMatchObject({ ok: false, first_broken_seq: 3 });
	});

	it("catches a rewritten hash", () => {
		const entries = chainOf(4);
		entries[1] = { ...entries[1], hash: "0".repeat(64) };
		expect(verifyChain(JOB, entries)).toMatchObject({ ok: false, first_broken_seq: 2 });
	});

	it("catches a re-linked chain, where an entry is pointed at the wrong parent", () => {
		const entries = chainOf(4);
		entries[2] = { ...entries[2], prev_hash: entries[0].hash };
		expect(verifyChain(JOB, entries)).toMatchObject({ ok: false, first_broken_seq: 3 });
	});

	it("catches an entry moved to another position", () => {
		const entries = chainOf(4);
		entries[1] = { ...entries[1], seq: 9 };
		expect(verifyChain(JOB, entries).ok).toBe(false);
	});

	it("says what went wrong, not just that something did", () => {
		const entries = chainOf(3);
		entries[1] = { ...entries[1], payload: { changed: true } };
		const result = verifyChain(JOB, entries);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/contents/);
	});
});

describe("retention", () => {
	it("keeps the chain verifiable after a payload expires", () => {
		// This is the whole reason expiry stores the content hash: the content is
		// gone and there is nothing left to recompute from.
		const entries = chainOf(4);
		entries[1] = expirePayload(entries[1]);

		expect(entries[1].payload).toBeNull();
		expect(verifyChain(JOB, entries)).toEqual({ ok: true, entries: 4 });
	});

	it("verifies with every payload expired", () => {
		const entries = chainOf(4).map(expirePayload);
		expect(verifyChain(JOB, entries).ok).toBe(true);
	});

	it("still catches tampering with an entry next to an expired one", () => {
		const entries = chainOf(4);
		entries[1] = expirePayload(entries[1]);
		entries[2] = { ...entries[2], payload: { forged: true } };
		expect(verifyChain(JOB, entries)).toMatchObject({ ok: false, first_broken_seq: 3 });
	});

	it("does not change an entry's own hash when its payload expires", () => {
		const [entry] = chainOf(1);
		expect(expirePayload(entry).hash).toBe(entry.hash);
	});

	it("expiring twice is not destructive", () => {
		const [entry] = chainOf(1);
		const once = expirePayload(entry);
		expect(expirePayload(once).payload_key).toBe(once.payload_key);
	});
});

describe("canonical serialisation", () => {
	it("does not depend on the order keys were written in", () => {
		// Verification recomputes from data that went through a database and a
		// JSON parser. If key order mattered, the chain would break on entries
		// nobody touched.
		expect(canonicalise({ b: 1, a: 2 })).toBe(canonicalise({ a: 2, b: 1 }));
	});

	it("gives the same hash for the same entry written twice", () => {
		const entry = { job_id: JOB, seq: 1, kind: "k", actor: "persona", payload: { a: [1, 2] } };
		expect(contentHash(entry)).toBe(contentHash({ ...entry }));
	});

	it("distinguishes values that look alike as text", () => {
		expect(canonicalise({ a: 1 })).not.toBe(canonicalise({ a: "1" }));
		expect(canonicalise([1])).not.toBe(canonicalise({ 0: 1 }));
	});

	it("handles nesting and nulls", () => {
		expect(canonicalise({ z: null, a: { c: 1, b: [null, { y: 1, x: 2 }] } })).toBe(
			'{"a":{"b":[null,{"x":2,"y":1}],"c":1},"z":null}',
		);
	});

	it("drops undefined rather than emitting it, since JSON has no such value", () => {
		expect(canonicalise({ a: 1, b: undefined })).toBe('{"a":1}');
	});
});
