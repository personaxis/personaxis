/**
 * The file, from the record, and back to the same file.
 *
 * The equivalence check that already existed went one way: turn a `state.json` into
 * entries and confirm the fold reproduces its coordinates. That proves the record
 * can HOLD the history. It does not prove the record can REPLACE the file, and the
 * difference is the whole of this migration: as long as the engine wrote the file
 * itself, there were two hash chains over one history, the `mutation_log` inside
 * `state.json` and the record, and two chains over the same facts can disagree with
 * nothing to say which is right.
 *
 * So this is the round trip. Replay a real state into entries, fold them, print the
 * file back, and require it to be the file we started with. Anything the projection
 * cannot reproduce shows up here as a difference, before anybody deletes the writer.
 *
 * Run against the personas on this machine when they are there, and against a built
 * one when they are not, so the test is meaningful in CI and load-bearing locally.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { StateFile } from "../src/persona.js";
import { derive } from "../src/record/derive.js";
import { replayStateFile } from "../src/record/bridge.js";
import { project, type Identity } from "../src/record/project.js";

/** Where a real one lives, if this machine has one. */
const REAL = [
	join(import.meta.dirname, "..", "..", "..", ".personaxis", "state.json"),
	join(
		import.meta.dirname,
		"..", "..", "..", "..",
		"persona.md", ".personaxis", "personas", "cmo", "state.json",
	),
].filter(existsSync);

function roundTrip(state: StateFile): StateFile {
	const entries = replayStateFile(state);
	const folded = derive(entries);
	expect(folded.ok, "a replayed state produced a chain that does not verify").toBe(true);

	const identity: Identity = {
		schemaVersion: state.schema_version,
		personaId: state.persona_id,
		personaVersion: state.persona_version,
		...(state.session_id === undefined ? {} : { sessionId: state.session_id }),
	};
	return project(folded.ok ? folded.state : ({} as never), entries, identity);
}

const sample = (): StateFile => ({
	schema_version: "1.1.0",
	persona_id: "clio",
	persona_version: "1.0.0",
	values: { "personality.traits.honesty": 0.9, "affect.baseline.mood.tone": 0.1 },
	mutation_log: [
		{
			ts: "2026-08-01T00:00:00.000Z",
			field: "affect.baseline.mood.tone",
			from: 0,
			to: 0.1,
			delta_requested: 0.1,
			clamped: false,
			reason: "a good review landed",
			actor: "actor-llm",
		} as never,
		{
			ts: "2026-08-01T00:01:00.000Z",
			field: "personality.traits.honesty",
			from: 0.95,
			to: 0.9,
			delta_requested: -0.2,
			clamped: true,
			reason: "clamped to the declared envelope",
			actor: "runtime-decay",
		} as never,
	],
});

describe("printing the state file from the record", () => {
	it("gives back every coordinate", () => {
		const before = sample();
		const after = roundTrip(before);

		expect(after.values).toEqual(before.values);
	});

	it("gives back the mutation log, in order, with what each one did", () => {
		// Every field the schema names, because a log that lost `clamped` would read
		// as a persona that moved where it asked to, which is the one thing the
		// envelope exists to prevent.
		const before = sample();
		const after = roundTrip(before);

		expect(after.mutation_log).toHaveLength(before.mutation_log.length);
		for (const [i, entry] of after.mutation_log.entries()) {
			const original = before.mutation_log[i]!;
			expect(entry.field).toBe(original.field);
			expect(entry.from).toBe(original.from);
			expect(entry.to).toBe(original.to);
			expect(entry.delta_requested).toBe(original.delta_requested);
			expect(entry.clamped).toBe(original.clamped);
			expect(entry.reason).toBe(original.reason);
			expect(entry.ts).toBe(original.ts);
		}
	});

	it("gives back the exact word it was given, for every actor the schema declares", () => {
		// This used to assert `self` and `runtime`, which is the bug written down as
		// the contract. Two mappings existed for one correspondence, in two files,
		// pointing opposite ways: the migration was faithful and the printing was not,
		// and the printing was the half that reached the disk. On a real persona 147
		// rows went in as `actor-llm` and `runtime-context` and came back out as
		// `self` and `runtime`, words that are not in the schema's enum at all, so
		// every row of the file failed the JSON Schema this project publishes.
		//
		// Every declared word, not the two the sample happens to use: a table with a
		// hole in it passes a test that only looks at the entries beside the hole.
		const actors = [
			"actor-llm",
			"runtime-decay",
			"runtime-context",
			"human-operator",
			"judge-correction",
		] as const;

		for (const actor of actors) {
			const one = sample();
			(one.mutation_log[0] as { actor: string }).actor = actor;

			expect(roundTrip(one).mutation_log[0]!.actor).toBe(actor);
		}
	});

	it("gives back a word this build does not know, rather than one it does", () => {
		// A file that used a sixth actor was already invalid against the published
		// schema. Printing one of our five over it would launder somebody's anomaly
		// into a fact, and refusing to print would leave them unable to write the file
		// at all for a problem they did not cause. It goes back out as it came in.
		const odd = sample();
		(odd.mutation_log[0] as { actor: string }).actor = "some-future-thing";

		const after = roundTrip(odd);

		expect(after.mutation_log).toHaveLength(odd.mutation_log.length);
		expect(after.mutation_log[0]!.actor).toBe("some-future-thing");
	});

	it("carries the record's own link and not a second chain over the same facts", () => {
		// Copying the old `prev_hash` forward would invite somebody to verify the
		// copy and believe they had verified the original.
		const after = roundTrip(sample());
		const entries = replayStateFile(sample());

		// Matched by what the entry is, not by where it sits: the origins come first,
		// so an index into the entries is not an index into the log.
		const printed = after.mutation_log[1]!;
		const source = entries.find(
			(e) => e.body.type === "value" && e.body.field === printed.field && e.at === printed.ts,
		);

		expect(source, "the printed row came from no entry").toBeDefined();
		expect((printed as never as { prev_hash: string }).prev_hash).toBe(source!.prev);
		expect((printed as never as { hash: string }).hash).toBe(source!.hash);
	});

	it("says which persona this is from the persona, not from the record", () => {
		// Identity is not an event. A record that carried it could disagree with the
		// spec about whose history it is.
		const after = roundTrip(sample());

		expect(after.persona_id).toBe("clio");
		expect(after.schema_version).toBe("1.1.0");
	});

	it("writes no session block for a persona that has never run", () => {
		// An empty one reads as "a session happened and did nothing", which is a
		// different claim from "nothing has happened".
		const after = roundTrip(sample());

		expect(after.agent_session).toBeUndefined();
	});
});

describe.runIf(REAL.length > 0)("against the states on this machine", () => {
	for (const path of REAL) {
		const name = path.replace(/\\/g, "/").split("/").slice(-4).join("/");

		it(`reproduces every coordinate of ${name}`, () => {
			// A superset, not an equality, and the difference is a finding rather than
			// a looser test: the log can name a coordinate the stored `values` dropped,
			// and that coordinate still had an origin. The record knows about it and
			// the file had forgotten, so requiring equality here would be requiring the
			// projection to forget too.
			const before = JSON.parse(readFileSync(path, "utf-8")) as StateFile;
			const after = roundTrip(before);

			for (const [field, value] of Object.entries(before.values)) {
				expect(after.values[field], `${field} came back different`).toBe(value);
			}
		});

		it(`reproduces the whole mutation log of ${name}`, () => {
			const before = JSON.parse(readFileSync(path, "utf-8")) as StateFile;
			const after = roundTrip(before);

			expect(after.mutation_log).toHaveLength(before.mutation_log.length);
			expect(after.mutation_log.map((e) => `${e.field}@${e.to}`)).toEqual(
				before.mutation_log.map((e) => `${e.field}@${e.to}`),
			);
		});

		it(`reproduces the identity of ${name}`, () => {
			const before = JSON.parse(readFileSync(path, "utf-8")) as StateFile;
			const after = roundTrip(before);

			expect(after.persona_id).toBe(before.persona_id);
			expect(after.persona_version).toBe(before.persona_version);
			expect(after.schema_version).toBe(before.schema_version);
		});
	}
});
