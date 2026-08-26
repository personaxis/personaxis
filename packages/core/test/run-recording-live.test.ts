/**
 * Turns reaching a real record, beside everything else that writes to it.
 *
 * `recordTurns` writes into a journal the caller owns, which is what a test wants and
 * what a live session must not do. A `Journal` chains onto the head it had when it
 * opened, and during a turn the living loop writes moves through its own: the held one
 * then appends a sequence number the file already used. Measured before the file
 * refused it: three entries on disk numbered 0, 1, 1, and the chain stopping at the
 * second of them, written by the ordinary path with nothing thrown.
 *
 * So these run the real observer against a real file with a real second writer in the
 * middle of the turn, because that interleaving is the whole reason it exists.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Envelope } from "../src/envelopes.js";
import type { StateFile } from "../src/persona.js";
import { adjust } from "../src/record/adjust.js";
import { authorOf } from "../src/record/actor.js";
import { verify } from "../src/record/chain.js";
import { readRecord, recordPathFor } from "../src/record/store.js";
import { recordingTurns } from "../src/run/recording.js";
import { TurnRunner } from "../src/run/service.js";
import type { TurnRequest } from "../src/run/vocabulary.js";

const ENVELOPES: Record<string, Envelope> = { "mood.tone": { mean: 0, min: -1, max: 1 } as Envelope };

const ASKED: TurnRequest = { turn: "t1", prompt: "how is the branch", asker: { kind: "human", id: "david" } };

let dir: string;
let personaPath: string;
let statePath: string;
let problems: Error[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-live-"));
	personaPath = join(dir, "personaxis.md");
	statePath = join(dir, "state.json");
	problems = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A state file as a persona that predates the record has one. */
function withHistory(rows: number): void {
	const mutation_log = Array.from({ length: rows }, (_, index) => ({
		ts: new Date(Date.UTC(2026, 5, index + 1)).toISOString(),
		field: "mood.tone",
		from: index * 0.01,
		to: (index + 1) * 0.01,
		delta_requested: 0.01,
		clamped: false,
		reason: `move ${index}`,
		actor: "actor-llm" as const,
		governance_blocked: false,
		prev_hash: "",
		hash: "",
	}));
	writeFileSync(
		statePath,
		JSON.stringify({
			schema_version: "1.1.0",
			persona_id: "clio",
			persona_version: "1.0.0",
			values: { "mood.tone": rows * 0.01 },
			mutation_log,
		} satisfies Partial<StateFile>),
	);
}

function observed(): TurnRunner {
	return new TurnRunner({
		provider: { name: "scripted", run: async () => ({ answer: "clean", steps: 2 }) },
		observer: recordingTurns({ personaPath, statePath, onProblem: (e) => problems.push(e) }),
	});
}

/** The bodies on disk, in order, so a test can say what a reader would meet. */
function onDisk(): string[] {
	return readRecord(recordPathFor(personaPath)).map((entry) => entry.body.type);
}

describe("a turn written to a real record", () => {
	it("lands on disk, in order, and verifies", async () => {
		await observed().run(ASKED);

		expect(onDisk()).toEqual(["turn-open", "message", "turn-close"]);
		expect(verify(readRecord(recordPathFor(personaPath))).ok).toBe(true);
	});

	it("survives a coordinate moving in the middle of the turn", async () => {
		// The interleaving that corrupted the file. The turn opens, the living loop
		// writes a move through its own journal, and the turn closes: a held journal
		// would close onto a head the file moved past.
		withHistory(0);
		const observer = recordingTurns({ personaPath, statePath, onProblem: (e) => problems.push(e) });

		await observer.opened!({ turn: "t1", prompt: "ask", asker: { kind: "human", id: "david" } });
		await adjust(personaPath, statePath, ENVELOPES, authorOf("actor-llm"), {
			field: "mood.tone",
			delta: 0.2,
			reason: "the loop ticked mid-turn",
		});
		await observer.closed!({ turn: "t1", stopReason: "answered", answer: "clean", steps: 1 });

		// The genesis the migration writes, then the turn opening, then the move, then
		// the close: three writers, one chain, in the order they happened.
		expect(onDisk()).toEqual(["value", "turn-open", "value", "message", "turn-close"]);
		expect(verify(readRecord(recordPathFor(personaPath))).ok).toBe(true);
		expect(problems).toEqual([]);
	});

	it("does not become the entry that shuts a persona out of its own past", async () => {
		// `Journal.adopt` only takes a history into a record with nothing in it, so a
		// turn written as entry zero would have made the next adjustment skip the
		// migration in silence and leave two months of history in a file the record had
		// already overtaken.
		withHistory(3);

		await observed().run(ASKED);

		// One genesis for the declared coordinate, three migrated moves, then the turn.
		expect(onDisk()).toEqual(["value", "value", "value", "value", "turn-open", "message", "turn-close"]);
		expect(verify(readRecord(recordPathFor(personaPath))).ok).toBe(true);
	});

	it("keeps the migrated dates, rather than stamping them with the turn", async () => {
		withHistory(3);

		await observed().run(ASKED);
		const moves = readRecord(recordPathFor(personaPath)).filter((e) => e.body.type === "value");

		// The genesis carries the first row's moment; the three moves carry their own.
		expect(moves.map((e) => e.at.slice(0, 10))).toEqual([
			"2026-06-01",
			"2026-06-01",
			"2026-06-02",
			"2026-06-03",
		]);
	});

	it("still lets the next coordinate move find the history", async () => {
		withHistory(2);
		await observed().run(ASKED);

		const { state } = await adjust(personaPath, statePath, ENVELOPES, authorOf("actor-llm"), {
			field: "mood.tone",
			delta: 0.1,
			reason: "after the turn",
		});

		// Two migrated rows plus the new one. A lost migration would print one.
		expect(state.mutation_log).toHaveLength(3);
	});
});

describe("the session block the file prints", () => {
	it("comes from the record, and says what the loop used to write itself", async () => {
		// Two writers for one block, disagreeing in two fields and settling on whichever
		// ran last. Measured on a real turn: the loop wrote `stop_reason: "goal_met"` and
		// the projection said `answered`, and the file flip-flopped between them as the
		// turn and the next coordinate move landed.
		withHistory(0);
		await observed().run(ASKED);

		const { state } = await adjust(personaPath, statePath, ENVELOPES, authorOf("actor-llm"), {
			field: "mood.tone",
			delta: 0.1,
			reason: "prints the file",
		});

		expect(state.agent_session).toEqual({
			// Nothing to resume: the turn answered.
			active_task: null,
			started_at: null,
			step_count: 2,
			token_count: 0,
			cost_usd: 0,
			stop_reason: "answered",
		});
	});

	it("points a resumed run at the question, not at a turn id", async () => {
		// The loop wrote the task TEXT here, and the projection wrote the open turn's
		// uuid. `resumeContext` prints it as "Last task: ...", so a uuid told the model
		// nothing at all. Same field, same meaning, one writer.
		withHistory(0);
		const runner = new TurnRunner({
			provider: {
				name: "broken",
				run: async () => {
					throw new Error("the model hung up");
				},
			},
			observer: recordingTurns({ personaPath, statePath, onProblem: (e) => problems.push(e) }),
		});

		await runner.run({ turn: "t1", prompt: "rewrite the ledger", asker: { kind: "human", id: "d" } });
		const { state } = await adjust(personaPath, statePath, ENVELOPES, authorOf("actor-llm"), {
			field: "mood.tone",
			delta: 0.1,
			reason: "prints the file",
		});

		expect(state.agent_session?.active_task).toBe("rewrite the ledger");
		expect(state.agent_session?.stop_reason).toBe("failed");
	});

	it("has nothing to say about a persona that has taken no turns", async () => {
		// An empty block reads as "a session happened and did nothing".
		withHistory(1);

		const { state } = await adjust(personaPath, statePath, ENVELOPES, authorOf("actor-llm"), {
			field: "mood.tone",
			delta: 0.1,
			reason: "no turns yet",
		});

		expect(state.agent_session).toBeUndefined();
	});
});

describe("when the record will not take the turn", () => {
	it("says so and does not take the answer away from the person", async () => {
		// The person is already reading their reply. Throwing here loses it, and there
		// is nothing useful to do with that; saying nothing is the one failure a record
		// cannot have.
		writeFileSync(recordPathFor(personaPath), '{"v":1,"seq":0,"at":"x","body":{"type":"compiled","hash":"h"},"prev":"","hash":"wrong"}\n');

		const outcome = await observed().run(ASKED);

		expect(outcome.answer).toBe("clean");
		expect(problems).toHaveLength(2);
		expect(problems[0]!.message).toMatch(/does not verify/);
	});

	it("leaves the damaged record exactly as it found it", async () => {
		const damaged = '{"v":1,"seq":0,"at":"x","body":{"type":"compiled","hash":"h"},"prev":"","hash":"wrong"}\n';
		writeFileSync(recordPathFor(personaPath), damaged);

		await observed().run(ASKED);

		expect(readFileSync(recordPathFor(personaPath), "utf-8")).toBe(damaged);
	});
});
