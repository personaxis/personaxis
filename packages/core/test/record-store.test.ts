/**
 * The record on disk, and moving a coordinate by writing to it.
 *
 * M1 proved the state file can be printed from the record. This is the other half:
 * the record has somewhere to live, so the engine can write there instead of into
 * `state.json`, and the two chains over one history become one.
 *
 * What these pin is mostly what happens when something is wrong, because that is
 * where an append-only file earns its keep or quietly stops being one.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Envelope } from "../src/envelopes.js";
import { verify } from "../src/record/chain.js";
import { derive } from "../src/record/derive.js";
import { currentValue, decide, mutate, origin } from "../src/record/mutate.js";
import { RecordDamaged, openRecord, readRecord, recordPathFor } from "../src/record/store.js";

const ENVELOPE: Envelope = { mean: 0, min: -1, max: 1 } as Envelope;
const ENVELOPES = { "mood.tone": ENVELOPE };
const WHO = { kind: "human", id: "david" } as never;

let dir: string;
let personaPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-store-"));
	personaPath = join(dir, "personaxis.md");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the file the record lives in", () => {
	it("reads a persona that has never moved as an empty record, not as an error", () => {
		// Different from a record that could not be read, and the difference is the
		// whole reason this is not one code path.
		expect(readRecord(recordPathFor(personaPath))).toEqual([]);
	});

	it("survives a restart with the same history and no duplicates", async () => {
		// The failure this catches: counting recovered entries as pending rewrites the
		// whole history on the next drain, which for an append-only file is the history
		// twice.
		const first = openRecord(personaPath);
		mutate(first, ENVELOPES, WHO, { field: "mood.tone", delta: 0.2, reason: "a good review" });
		await first.drain();

		const second = openRecord(personaPath);
		mutate(second, ENVELOPES, WHO, { field: "mood.tone", delta: 0.1, reason: "another" });
		await second.drain();

		const onDisk = readRecord(recordPathFor(personaPath));
		expect(onDisk).toHaveLength(2);
		expect(second.verify().ok).toBe(true);
	});

	it("refuses a damaged line instead of skipping it", async () => {
		// Skipping would shorten the history silently, and every hash after the gap
		// would still verify against a chain that is missing a link. That is a record
		// that lies with a clean bill of health.
		const record = openRecord(personaPath);
		mutate(record, ENVELOPES, WHO, { field: "mood.tone", delta: 0.2, reason: "one" });
		mutate(record, ENVELOPES, WHO, { field: "mood.tone", delta: 0.1, reason: "two" });
		await record.drain();

		const path = recordPathFor(personaPath);
		const lines = readFileSync(path, "utf-8").split("\n");
		lines[0] = "{not json";
		writeFileSync(path, lines.join("\n"));

		expect(() => readRecord(path)).toThrow(RecordDamaged);
		expect(() => readRecord(path)).toThrow(/:1 /);
	});

	it("refuses an append from a journal the file has moved past, and stays intact", async () => {
		// Measured before the file refused: three entries on disk numbered 0, 1, 1, and
		// the chain stopping at the second of them, written by the ordinary path with
		// nothing thrown. A REPL holding one journal across a turn while the living loop
		// writes through its own is exactly this shape.
		const long = openRecord(personaPath);
		mutate(long, ENVELOPES, WHO, { field: "mood.tone", delta: 0.1, reason: "one" });
		await long.drain();

		const other = openRecord(personaPath);
		mutate(other, ENVELOPES, WHO, { field: "mood.tone", delta: 0.1, reason: "two" });
		await other.drain();

		mutate(long, ENVELOPES, WHO, { field: "mood.tone", delta: 0.1, reason: "three" });
		const report = await long.drain();

		expect(report.written).toBe(0);
		expect(report.failure?.message).toMatch(/view of the record that has since moved/);
		// Nothing landed, so the record is still what the other journal left, and the
		// refused entry is still pending rather than dropped as though it had landed.
		const onDisk = readRecord(recordPathFor(personaPath));
		expect(onDisk.map((e) => e.seq)).toEqual([0, 1]);
		expect(verify(onDisk).ok).toBe(true);
		expect(long.pending).toBe(1);
	});

	it("takes the write once the journal is opened again from where the record is", async () => {
		// The other half of the refusal: it is a stale view, not a permanent refusal,
		// and the fix is the discipline the message names.
		const first = openRecord(personaPath);
		mutate(first, ENVELOPES, WHO, { field: "mood.tone", delta: 0.1, reason: "one" });
		await first.drain();

		const stale = openRecord(personaPath);
		const winner = openRecord(personaPath);
		mutate(winner, ENVELOPES, WHO, { field: "mood.tone", delta: 0.1, reason: "theirs" });
		await winner.drain();

		mutate(stale, ENVELOPES, WHO, { field: "mood.tone", delta: 0.1, reason: "mine, refused" });
		expect((await stale.drain()).failure).toBeDefined();

		const reopened = openRecord(personaPath);
		mutate(reopened, ENVELOPES, WHO, { field: "mood.tone", delta: 0.1, reason: "mine, landed" });
		expect((await reopened.drain()).written).toBe(1);
		expect(reopened.verify().ok).toBe(true);
	});

	it("drops a trailing half-written entry, which is what a crash leaves", async () => {
		const record = openRecord(personaPath);
		mutate(record, ENVELOPES, WHO, { field: "mood.tone", delta: 0.2, reason: "landed" });
		await record.drain();

		const path = recordPathFor(personaPath);
		writeFileSync(path, readFileSync(path, "utf-8") + '{"seq":1,"at":"2026');

		// One complete entry, and the unfinished one is gone rather than fatal: it is
		// an append that never finished, not damage in the middle.
		expect(readRecord(path)).toHaveLength(1);
	});
});

describe("deciding where a value lands", () => {
	it("clamps to the envelope and says it clamped", () => {
		// Not refused. Refusing loses the fact that something tried; clamping silently
		// lets a reader believe the persona moved where it was asked to.
		const decision = decide(0.9, ENVELOPE, { field: "mood.tone", delta: 0.5, reason: "r" });

		expect(decision.to).toBe(1);
		expect(decision.requested).toBeCloseTo(1.4);
		expect(decision.clamped).toBe(true);
	});

	it("does not move a blocked coordinate, and does not call that clamping", () => {
		// An audit has to tell "it went as far as it was allowed" from "it was not
		// allowed to go", and reporting both flags would read as two refusals.
		const decision = decide(0.5, ENVELOPE, {
			field: "mood.tone",
			delta: 0.2,
			reason: "r",
			blocked: true,
		});

		expect(decision.to).toBe(0.5);
		expect(decision.blocked).toBe(true);
		expect(decision.clamped).toBe(false);
	});

	it("refuses a delta that is not a number rather than storing a NaN", () => {
		expect(() => decide(0, ENVELOPE, { field: "mood.tone", delta: Number.NaN, reason: "r" })).toThrow();
	});

	it("needs no clock and no file, so the arithmetic can be checked as arithmetic", () => {
		const once = decide(0.1, ENVELOPE, { field: "mood.tone", delta: 0.2, reason: "r" });
		const twice = decide(0.1, ENVELOPE, { field: "mood.tone", delta: 0.2, reason: "r" });

		expect(once).toEqual(twice);
	});
});

describe("moving a coordinate through the record", () => {
	it("puts the new value where the fold can find it", () => {
		const record = openRecord(personaPath);

		mutate(record, ENVELOPES, WHO, { field: "mood.tone", delta: 0.3, reason: "a good review" });

		const folded = derive(record.all());
		expect(folded.ok && folded.state.values["mood.tone"]).toBeCloseTo(0.3);
	});

	it("starts from where the spec put the coordinate, not from zero", () => {
		// A coordinate that has never moved is at its declared mean. Reading it as 0
		// would make the first mutation of any non-zero-centred trait wrong.
		const offset: Envelope = { mean: 0.7, min: 0, max: 1 } as Envelope;
		const record = openRecord(personaPath);

		expect(currentValue(record, "personality.traits.honesty", offset)).toBe(0.7);
	});

	it("refuses a field with no envelope, and names what it could have moved", () => {
		const record = openRecord(personaPath);

		expect(() => mutate(record, ENVELOPES, WHO, { field: "nope", delta: 0.1, reason: "r" })).toThrow(
			/mood\.tone/,
		);
	});

	it("writes a starting position once, stamped as genesis", () => {
		// An origin recorded as a change makes every audit begin with a movement
		// nobody made, and makes the first real change look like the second.
		const record = openRecord(personaPath);

		origin(record, "mood.tone", 0);
		origin(record, "mood.tone", 0);

		expect(record.all()).toHaveLength(1);
		expect(record.all()[0]!.author).toMatchObject({ mechanism: "genesis" });
	});

	it("keeps one chain, and it verifies", () => {
		// The whole point of the migration: the state file used to carry its own chain
		// over the same facts, and two chains over one history can disagree with
		// nothing to say which is right.
		const record = openRecord(personaPath);
		origin(record, "mood.tone", 0);
		mutate(record, ENVELOPES, WHO, { field: "mood.tone", delta: 0.3, reason: "one" });
		mutate(record, ENVELOPES, WHO, { field: "mood.tone", delta: 0.9, reason: "two, clamped" });

		expect(record.verify().ok).toBe(true);
		const folded = derive(record.all());
		expect(folded.ok && folded.state.values["mood.tone"]).toBe(1);
	});
});
