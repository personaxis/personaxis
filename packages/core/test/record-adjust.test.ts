/**
 * The whole path: a persona moves, the record holds it, the state file is printed.
 *
 * This is the step that makes `state.json` a view. Before it, a mutation was pushed
 * onto a log inside that file and chained there, so there were two hash chains over
 * one history and nothing to say which was right when they disagreed.
 *
 * The case that decides whether this migration is usable is not the happy one. It is
 * a persona that already exists, with history in the old place and an empty record,
 * because that is every persona on every machine today.
 */

import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Envelope } from "../src/envelopes.js";
import type { StateFile } from "../src/persona.js";
import { adjust } from "../src/record/adjust.js";
import { fileSink, readRecord, recordPathFor } from "../src/record/store.js";

const ENVELOPES = {
	"mood.tone": { mean: 0, min: -1, max: 1 } as Envelope,
	"personality.traits.honesty": { mean: 0.9, min: 0.8, max: 1 } as Envelope,
};
const WHO = { kind: "human", id: "david" } as never;

let dir: string;
let personaPath: string;
let statePath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-adjust-"));
	personaPath = join(dir, "personaxis.md");
	statePath = join(dir, "state.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeState(log: unknown[] = []): StateFile {
	const state: StateFile = {
		schema_version: "1.1.0",
		persona_id: "clio",
		persona_version: "1.0.0",
		values: { "mood.tone": 0 },
		mutation_log: log as never,
	};
	writeFileSync(statePath, JSON.stringify(state, null, 2));
	return state;
}

const row = (field: string, from: number, to: number, reason: string) => ({
	ts: "2026-08-01T00:00:00.000Z",
	field,
	from,
	to,
	delta_requested: to - from,
	clamped: false,
	reason,
	actor: "actor-llm",
});

describe("a persona that has never moved", () => {
	it("records the move and prints the value back", async () => {
		writeState();

		const { decision, state } = await adjust(personaPath, statePath, ENVELOPES, WHO, {
			field: "mood.tone",
			delta: 0.3,
			reason: "a good review landed",
		});

		expect(decision.to).toBeCloseTo(0.3);
		expect(state.values["mood.tone"]).toBeCloseTo(0.3);
	});

	it("leaves the state file on disk saying the same thing", async () => {
		writeState();

		await adjust(personaPath, statePath, ENVELOPES, WHO, {
			field: "mood.tone",
			delta: 0.3,
			reason: "a good review landed",
		});

		const onDisk = JSON.parse(readFileSync(statePath, "utf-8")) as StateFile;
		expect(onDisk.values["mood.tone"]).toBeCloseTo(0.3);
		expect(onDisk.mutation_log).toHaveLength(1);
	});

	it("puts the move in the record, durably, before it returns", async () => {
		// Awaited on purpose. An adjustment IS the operation somebody asked for, so
		// returning before it is durable would report a change a crash could take back.
		writeState();

		await adjust(personaPath, statePath, ENVELOPES, WHO, {
			field: "mood.tone",
			delta: 0.3,
			reason: "a good review landed",
		});

		// Two, not one: the coordinate's declared starting position is written as an
		// origin before the move, so the record does not begin with a value that
		// appeared from nowhere. The origin is stamped `genesis` precisely so a fold
		// does not count it as something that happened to the persona.
		const entries = readRecord(recordPathFor(personaPath));
		expect(entries).toHaveLength(2);
		expect(entries[0]!.author).toMatchObject({ mechanism: "genesis" });
		expect(entries[1]!.body).toMatchObject({ type: "value", reason: "a good review landed" });
	});
});

describe("a persona that already has a history in the old place", () => {
	it("adopts it, so the record does not begin mid-life", async () => {
		// The case that decides whether this is usable: every persona on every machine
		// today looks like this. A record that starts at the current value is an audit
		// that begins with a persona appearing from nowhere.
		writeState([
			row("mood.tone", 0, 0.1, "first"),
			row("mood.tone", 0.1, 0.2, "second"),
		]);

		const { state } = await adjust(personaPath, statePath, ENVELOPES, WHO, {
			field: "mood.tone",
			delta: 0.1,
			reason: "third",
		});

		expect(state.mutation_log).toHaveLength(3);
		expect(state.mutation_log.map((e) => e.reason)).toEqual(["first", "second", "third"]);
	});

	it("adopts it once, not on every write", async () => {
		writeState([row("mood.tone", 0, 0.1, "first")]);

		await adjust(personaPath, statePath, ENVELOPES, WHO, { field: "mood.tone", delta: 0.1, reason: "second" });
		await adjust(personaPath, statePath, ENVELOPES, WHO, { field: "mood.tone", delta: 0.1, reason: "third" });

		// Three moves, not four and not five. A replay that ran again would duplicate
		// the whole history on every write.
		const onDisk = JSON.parse(readFileSync(statePath, "utf-8")) as StateFile;
		expect(onDisk.mutation_log).toHaveLength(3);
	});

	it("keeps every row exactly as the file had it, and not as of the migration", async () => {
		// The one that matters most and the one that was wrong. Adopting replayed the
		// history through `append`, which stamps the clock and takes only an author and
		// a body, so every adopted row came out dated the instant of the upgrade and
		// carrying none of the machine or session the row knew about. Measured on this
		// repo's own persona: 147 rows spanning two months came back with 147 identical
		// timestamps. A history whose dates are all the moment somebody upgraded is not
		// a history, and nothing here was comparing the two sides.
		//
		// Every field, not the ones that were broken: a migration is faithful or it is
		// not, and checking the two that failed last time is how the third goes
		// unnoticed.
		const before = [
			{
				...row("mood.tone", 0, 0.2, "june"),
				ts: "2026-06-01T09:00:00.000Z",
				origin_node: "laptop",
				session_id: "s-june",
				tool_call_id: "call-1",
			},
			{
				...row("mood.tone", 0.2, 0.35, "july"),
				ts: "2026-07-14T18:30:00.000Z",
				actor: "runtime-context",
				origin_node: "desktop",
				session_id: "s-july",
			},
		];
		writeState(before);

		const after = (await adjust(personaPath, statePath, ENVELOPES, WHO, {
			field: "mood.tone",
			delta: 0.05,
			reason: "today",
		})).state;

		// The adopted rows come back byte for byte, in order, minus the chain links,
		// which are the record's own and deliberately not the old file's.
		for (const [i, original] of before.entries()) {
			const printed = after.mutation_log[i]! as unknown as Record<string, unknown>;
			for (const [key, value] of Object.entries(original)) {
				expect({ row: i, key, value: printed[key] }).toEqual({ row: i, key, value });
			}
		}
	});

	it("marks a move made now as made now, and not as of the oldest row", async () => {
		// The mirror of the test above: keeping the old dates must not be implemented
		// by giving everything the same date. The migration is faithful and the new
		// entry is current, and only checking one of those passes with either bug.
		writeState([{ ...row("mood.tone", 0, 0.2, "june"), ts: "2026-06-01T09:00:00.000Z" }]);

		const before = Date.now();
		const after = (await adjust(personaPath, statePath, ENVELOPES, WHO, {
			field: "mood.tone",
			delta: 0.05,
			reason: "today",
			provenance: { node: "this-machine", session: "s-now", toolCall: "call-now" },
		})).state;

		const fresh = after.mutation_log.at(-1)!;
		expect(new Date(fresh.ts).getTime()).toBeGreaterThanOrEqual(before);
		expect(fresh.origin_node).toBe("this-machine");
		expect(fresh.session_id).toBe("s-now");
		expect(fresh.tool_call_id).toBe("call-now");
	});

	it("continues from where the old history left the value", async () => {
		writeState([row("mood.tone", 0, 0.4, "earlier")]);

		const { decision } = await adjust(personaPath, statePath, ENVELOPES, WHO, {
			field: "mood.tone",
			delta: 0.1,
			reason: "later",
		});

		expect(decision.from).toBeCloseTo(0.4);
		expect(decision.to).toBeCloseTo(0.5);
	});
});

describe("a record this build cannot read", () => {
	/** An entry as some other build would have left it, written the way the code writes. */
	async function laid(entry: unknown): Promise<string> {
		const path = recordPathFor(personaPath);
		await fileSink(path).append([entry as never]);
		return path;
	}

	it("is refused before anything is added to it, and the file is left alone", async () => {
		// The check used to run after the drain, so an unreadable record received the new
		// entry, the entry reached the disk, and only then did it throw. A refusal that
		// leaves the record worse than it found it is not a refusal.
		writeState();
		const path = await laid({
			v: 0,
			seq: 0,
			at: "2026-06-01T00:00:00.000Z",
			prev: "",
			hash: "x",
			author: { kind: "human", id: "someone" },
			body: {
				type: "value",
				field: "mood.tone",
				from: 0,
				to: 0.1,
				delta: 0.1,
				clamped: false,
				blocked: false,
				reason: "from an older build",
			},
		});

		await expect(
			adjust(personaPath, statePath, ENVELOPES, WHO, {
				field: "mood.tone",
				delta: 0.1,
				reason: "now",
			}),
		).rejects.toThrow(/shape 0.*shape 1/s);

		expect(readRecord(path)).toHaveLength(1);
	});

	it("says nothing is wrong with it, because nothing is", async () => {
		// Reported as a bare problem name it reads as damage, and somebody goes looking
		// for tampering that did not happen, at the moment they most need to trust it.
		writeState();
		await laid({
			v: 99,
			seq: 0,
			at: "2026-06-01T00:00:00.000Z",
			prev: "",
			hash: "x",
			author: { kind: "human", id: "someone" },
			body: { type: "failure", code: "c", message: "m" },
		});

		await expect(
			adjust(personaPath, statePath, ENVELOPES, WHO, {
				field: "mood.tone",
				delta: 0.1,
				reason: "now",
			}),
		).rejects.toThrow(/Nothing is wrong with it/);
	});
});

describe("what the record is for", () => {
	it("makes the state file a view: delete it and the next write brings it back", async () => {
		writeState();
		await adjust(personaPath, statePath, ENVELOPES, WHO, { field: "mood.tone", delta: 0.3, reason: "one" });

		const before = readFileSync(statePath, "utf-8");
		rmSync(statePath);
		writeState();

		// The record still holds the first move, so the second write prints both.
		const { state } = await adjust(personaPath, statePath, ENVELOPES, WHO, {
			field: "mood.tone",
			delta: 0.1,
			reason: "two",
		});

		expect(existsSync(statePath)).toBe(true);
		expect(state.mutation_log).toHaveLength(2);
		expect(before).toContain("one");
	});

	it("clamps to the envelope and prints that it clamped", async () => {
		writeState();

		const { state } = await adjust(personaPath, statePath, ENVELOPES, WHO, {
			field: "mood.tone",
			delta: 5,
			reason: "far too much",
		});

		expect(state.values["mood.tone"]).toBe(1);
		expect(state.mutation_log[0]!.clamped).toBe(true);
	});

	it("keeps one chain over the history, and it verifies", async () => {
		writeState([row("mood.tone", 0, 0.2, "earlier")]);
		await adjust(personaPath, statePath, ENVELOPES, WHO, { field: "mood.tone", delta: 0.1, reason: "later" });

		const entries = readRecord(recordPathFor(personaPath));
		const seqs = entries.map((e) => e.seq);

		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		for (const [i, entry] of entries.entries()) {
			if (i === 0) continue;
			expect(entry.prev).toBe(entries[i - 1]!.hash);
		}
	});
});
