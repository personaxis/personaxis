/**
 * The exact row the record writes, pinned.
 *
 * This was a comparison. It ran the same move through the old engine and through the
 * record and asserted the two rows were identical, because R6 had only ever proved the
 * other direction: that folding an existing `state.json` reproduces what it already
 * said. That covers history and covered nothing about what happens next, and the gap
 * cost what an uncompared path costs. `delta_requested` means a delta and the entry was
 * keeping the position that had been asked for, so a real move of 0.02 on a real
 * persona was written down as 1.01, on every row, while every test passed.
 *
 * The comparison could only exist while both writers did. The old engine is gone, so
 * what stands in its place is what that version of this file said would: the same
 * expectations, frozen as literals. They were captured from the engine that ships,
 * against the rows the engine it replaced produced, and they do not move without
 * somebody deciding they should.
 *
 * The other half of the guard is in the CLI: the printed document is validated against
 * the JSON Schema this project publishes, so a row that drifts out of the enum or loses
 * a required field fails there rather than here.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Envelope } from "../src/envelopes.js";
import type { MutationLogEntry, StateFile } from "../src/persona.js";
import { adjust } from "../src/record/adjust.js";
import { authorOf } from "../src/record/actor.js";
import type { MoveRequest } from "../src/record/mutate.js";
import { recordPathFor } from "../src/record/store.js";

const ENVELOPES: Record<string, Envelope> = {
	"mood.tone": { mean: 0, min: -0.5, max: 0.5 } as Envelope,
};

let dir: string;
let personaPath: string;
let statePath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-row-"));
	personaPath = join(dir, "personaxis.md");
	statePath = join(dir, "state.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The row one move leaves behind, without the parts that are not facts about it.
 *
 * The moment and the chain links are dropped: a clock and a hash cannot be written as
 * literals without pinning the time the test ran. Everything else is the move.
 */
async function rowFor(actor: MutationLogEntry["actor"], request: MoveRequest): Promise<Record<string, unknown>> {
	rmSync(recordPathFor(personaPath), { force: true });
	writeFileSync(
		statePath,
		JSON.stringify({
			schema_version: "1.1.0",
			persona_id: "t",
			persona_version: "1.0.0",
			values: { "mood.tone": 0.1 },
			mutation_log: [],
		} satisfies Partial<StateFile>),
	);

	const { state } = await adjust(personaPath, statePath, ENVELOPES, authorOf(actor), request);
	const { ts, prev_hash, hash, ...facts } = state.mutation_log[0]! as MutationLogEntry & {
		prev_hash?: string;
		hash?: string;
	};
	// Named so the destructuring reads as deliberate rather than as three unused names.
	expect(typeof ts).toBe("string");
	expect(typeof hash).toBe("string");
	expect(typeof prev_hash).toBe("string");
	return facts as Record<string, unknown>;
}

describe("the row a move leaves behind", () => {
	it("is exactly this, for an ordinary move", async () => {
		expect(await rowFor("actor-llm", { field: "mood.tone", delta: 0.2, reason: "a good turn" })).toEqual({
			field: "mood.tone",
			from: 0.1,
			to: 0.30000000000000004,
			delta_requested: 0.2,
			clamped: false,
			reason: "a good turn",
			actor: "actor-llm",
			governance_blocked: false,
		});
	});

	it("is exactly this when the envelope clamps it", async () => {
		// Where `delta_requested` earns its keep: the schema says it may differ from
		// `to - from` precisely here, so this is the row that shows which of the two an
		// entry is keeping.
		expect(
			await rowFor("actor-llm", { field: "mood.tone", delta: 9, reason: "way past the ceiling" }),
		).toEqual({
			field: "mood.tone",
			from: 0.1,
			to: 0.5,
			delta_requested: 9,
			clamped: true,
			reason: "way past the ceiling",
			actor: "actor-llm",
			governance_blocked: false,
		});
	});

	it("is exactly this when governance refused the move", async () => {
		// A refusal is recorded, not skipped, and `from === to` with the attempt still
		// legible is what makes it auditable without a second rule.
		expect(
			await rowFor("actor-llm", { field: "mood.tone", delta: 0.3, reason: "not allowed", blocked: true }),
		).toEqual({
			field: "mood.tone",
			from: 0.1,
			to: 0.1,
			delta_requested: 0.3,
			clamped: false,
			reason: "not allowed",
			actor: "actor-llm",
			governance_blocked: true,
		});
	});

	it("carries the machine and the tool call where reconciliation reads them", async () => {
		expect(
			await rowFor("actor-llm", {
				field: "mood.tone",
				delta: 0.1,
				reason: "from a tool",
				provenance: { node: "laptop", toolCall: "call-77" },
			}),
		).toEqual({
			field: "mood.tone",
			from: 0.1,
			to: 0.2,
			delta_requested: 0.1,
			clamped: false,
			reason: "from a tool",
			actor: "actor-llm",
			governance_blocked: false,
			origin_node: "laptop",
			tool_call_id: "call-77",
		});
	});

	it("keeps a negative delta exactly, rather than through a position", async () => {
		// `-0.2` came back as `-0.19999999999999996` when the entry kept the position it
		// aimed at and the projection subtracted. Float noise inside a hash chain is
		// noise nobody can explain later.
		const row = await rowFor("runtime-decay", { field: "mood.tone", delta: -0.2, reason: "exactly" });

		expect(row.delta_requested).toBe(-0.2);
		expect(row.actor).toBe("runtime-decay");
	});

	it("names every actor the schema declares, and none it does not", async () => {
		for (const actor of [
			"actor-llm",
			"runtime-decay",
			"runtime-context",
			"human-operator",
			"judge-correction",
		] as const) {
			const row = await rowFor(actor, { field: "mood.tone", delta: -0.05, reason: "each one" });
			expect({ asked: actor, wrote: row.actor }).toEqual({ asked: actor, wrote: actor });
		}
	});
});
