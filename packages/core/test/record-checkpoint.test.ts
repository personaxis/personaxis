/**
 * Reading a persona without folding its whole life.
 *
 * Reading means folding the record, and the record only grows: 167 entries fold in
 * about a millisecond, 10,000 in 48ms, 50,000 in 227ms, on a file nothing ever
 * shortens. That is a read path that works today and stops working later, which is
 * worse than one that is slow now, because nobody notices until the persona nobody
 * can afford to lose is the slow one. With a checkpoint every two hundred entries the
 * same reads take 1.6ms, 1.7ms and 1.4ms: flat in the size of the history.
 *
 * ## The property that makes the shortcut safe
 *
 * A checkpoint is a claim about what the entries before it add up to, and a reader
 * that starts from one is believing the claim. So the claim must be checkable, and it
 * is: `derive` SKIPS checkpoints, which means folding from zero is always the truth
 * and never something a checkpoint can replace. Every test here that compares the two
 * is checking a claim against that truth rather than against another claim.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chain } from "../src/record/chain.js";
import { derive } from "../src/record/derive.js";
import { ENTRY_VERSION, type DraftEntry, type RecordBody, type RecordEntry } from "../src/record/entry.js";
import { readTail, stateFrom } from "../src/record/store.js";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-ckpt-"));
	path = join(dir, "record.jsonl");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SELF = { kind: "persona", id: "self" } as const;
const RUNTIME = { kind: "runtime", mechanism: "checkpoint", reason: "so a reader can start here" } as const;

function draft(body: RecordBody, author: DraftEntry["author"] = SELF, at = "2026-08-01T00:00:00.000Z"): DraftEntry {
	return { v: ENTRY_VERSION, at, author, body };
}

/** The move entry number `i` would be, so two records can be built from one script. */
function move(i: number): RecordBody {
	return {
		type: "value",
		field: i % 2 === 0 ? "mood.tone" : "traits.openness",
		from: i / 100,
		to: (i + 1) / 100,
		delta: 0.01,
		clamped: false,
		blocked: false,
		reason: `move ${i}`,
	};
}

/**
 * A history of `n` moves with a checkpoint every `every` entries, on disk.
 *
 * The running fold is kept as it goes rather than re-derived at each checkpoint,
 * which is also how the real writer does it: re-folding to write a checkpoint would
 * make writing one cost what reading without one costs.
 */
function history(n: number, every = 0, file = path): RecordEntry[] {
	const entries: RecordEntry[] = [];
	for (let i = 0; i < n; i += 1) {
		const checkpointHere = every > 0 && i > 0 && i % every === 0;
		let body: RecordBody;
		if (checkpointHere) {
			const folded = derive(entries);
			if (!folded.ok) throw new Error("the history under construction does not verify");
			body = { type: "checkpoint", state: folded.state };
		} else {
			body = move(i);
		}
		const prev = entries.at(-1)?.hash ?? "";
		entries.push(chain(draft(body, checkpointHere ? RUNTIME : SELF), entries.length, prev));
	}
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return entries;
}

describe("starting from a checkpoint", () => {
	it("gives exactly what folding the whole record gives", () => {
		const entries = history(500, 200);

		const whole = derive(entries);
		const short = stateFrom(path);

		expect(short.ok).toBe(true);
		expect(whole.ok).toBe(true);
		if (!short.ok || !whole.ok) return;
		expect(short.state).toEqual(whole.state);
	});

	it("agrees at every size and spacing, not just the one this was written with", () => {
		// A shortcut that is right for 500 entries every 200 and wrong when the last
		// checkpoint lands on the final entry, or when there are more checkpoints than
		// moves between them, is a shortcut nobody should use.
		for (const [n, every] of [
			[1, 0],
			[5, 2],
			[10, 1],
			[201, 200],
			[200, 200],
			[199, 200],
			[1000, 50],
		] as const) {
			rmSync(path, { force: true });
			const entries = history(n, every);
			const whole = derive(entries);
			const short = stateFrom(path);

			expect({ n, every, ok: short.ok }).toEqual({ n, every, ok: true });
			if (!short.ok || !whole.ok) continue;
			expect({ n, every, state: short.state }).toEqual({ n, every, state: whole.state });
		}
	});

	it("is flat rather than growing, which is the whole reason it exists", () => {
		history(1200, 200);
		const first = readTail(path);

		expect(first.checkpointed).toBe(true);
		// What is left to fold is bounded by the spacing, not by the history.
		expect(first.entries.length).toBeLessThanOrEqual(200);
	});

	it("crosses a block boundary rather than giving up at it", () => {
		// The file is read backwards in blocks, so a checkpoint further back than one
		// block is the case that decides whether this works at all. A tiny block makes
		// the crossing certain instead of hoping the numbers line up.
		const entries = history(400, 200);

		const tail = readTail(path, 512);
		expect(tail.checkpointed).toBe(true);

		const whole = derive(entries);
		const short = stateFrom(path);
		expect(whole.ok && short.ok).toBe(true);
		if (!whole.ok || !short.ok) return;
		expect(short.state).toEqual(whole.state);
	});
});

describe("what a checkpoint is not allowed to be", () => {
	it("is skipped when folding from zero, so it can never replace the truth", () => {
		// The property everything else rests on. If folding applied checkpoints, a false
		// one would become the answer and there would be nothing left to check it
		// against. Two records built from the same moves, one with checkpoints and one
		// without, have to fold to the same persona.
		const plain = join(dir, "plain.jsonl");
		const withThem = history(20, 5);
		const withoutThem: RecordEntry[] = [];
		for (const entry of withThem) {
			if (entry.body.type === "checkpoint") continue;
			withoutThem.push(
				chain(draft(entry.body, entry.author, entry.at), withoutThem.length, withoutThem.at(-1)?.hash ?? ""),
			);
		}
		writeFileSync(plain, withoutThem.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

		const a = derive(withThem);
		const b = derive(withoutThem);

		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(a.state.values).toEqual(b.state.values);
		expect(a.state.turnCount).toBe(b.state.turnCount);
	});

	it("does not hide an entry edited after it", () => {
		// The trade a checkpoint makes is not reading the history behind it. It is not
		// a licence to stop checking the part it does read.
		const entries = history(300, 200);
		const edited = entries.map((entry, index) =>
			index === entries.length - 1 ? { ...entry, hash: "0".repeat(64) } : entry,
		);
		writeFileSync(path, edited.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

		expect(stateFrom(path).ok).toBe(false);
	});

	it("does not make a record without one unreadable", () => {
		// Every record written before checkpoints existed has none, and reading whole is
		// the honest fallback rather than an error.
		const entries = history(50);

		const tail = readTail(path);

		expect(tail.checkpointed).toBe(false);
		expect(tail.entries).toHaveLength(entries.length);
		expect(stateFrom(path).ok).toBe(true);
	});

	it("reports a record whose claim disagrees with its own history", () => {
		// A checkpoint cannot be edited after the fact, because its hash is in the
		// chain. It can be written wrong in the first place, and folding from zero is
		// what says so, which is only possible because the fold ignores it.
		const entries = history(300, 200);
		const forged = entries.map((entry) =>
			entry.body.type === "checkpoint"
				? {
						...entry,
						body: { ...entry.body, state: { ...entry.body.state, values: { "mood.tone": 99 } } },
					}
				: entry,
		);
		writeFileSync(path, forged.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

		const claimed = stateFrom(path);
		const truth = derive(forged);

		// Both refuse, and for the reason that matters: the body is inside the hash, so
		// a rewritten claim no longer matches its own entry. The fast read used to
		// believe it, because it chained the tail onto the checkpoint's STORED hash
		// without ever recomputing it, which handed a reader a persona that never
		// existed. It recomputes that one hash now and falls back to the whole record,
		// where the tampering is reported properly.
		expect(truth.ok).toBe(false);
		expect(claimed.ok).toBe(false);
		expect(claimed.ok === false && claimed.problem.kind).toBe("altered");
	});
});
