/**
 * A row the record writes, against the row the old engine would have written.
 *
 * R6 proved the other direction: folding an existing `state.json` reproduces what it
 * already said. That covers history, and it covered nothing about what happens next.
 * A new move went through a different path with different arithmetic, and the only
 * comparison anybody had was between two copies of the past.
 *
 * It cost exactly what an uncompared path costs. `delta_requested` means a delta and
 * the entry was keeping the position that had been asked for, so a real move of 0.02
 * on a real persona was written down as 1.01, on every row, and every test passed:
 * the migration tests compare rows coming IN, and this is what goes OUT.
 *
 * ## This test dies with the old engine, and that is the point
 *
 * It can only exist while both writers do, which is the window R8 lives in. When the
 * old engine goes, what replaces this is the schema check in the CLI plus these
 * expectations frozen as literals. Deleting it with nothing in its place would drop
 * the only thing comparing the two.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Envelope } from "../src/envelopes.js";
import type { MutationLogEntry, StateFile } from "../src/persona.js";
import { applyMutation } from "../src/state-engine.js";
import { adjust } from "../src/record/adjust.js";
import { authorOf } from "../src/record/actor.js";
import { recordPathFor } from "../src/record/store.js";

const ENVELOPES: Record<string, Envelope> = {
	"mood.tone": { mean: 0, min: -0.5, max: 0.5 } as Envelope,
};

let dir: string;
let personaPath: string;
let statePath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-equiv-"));
	personaPath = join(dir, "personaxis.md");
	statePath = join(dir, "state.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fresh(): StateFile {
	return {
		schema_version: "1.1.0",
		persona_id: "t",
		persona_version: "1.0.0",
		values: { "mood.tone": 0.1 },
		mutation_log: [],
	} as unknown as StateFile;
}

/** Everything about a row that is a fact rather than a moment. */
function facts(row: MutationLogEntry): Record<string, unknown> {
	return {
		field: row.field,
		from: row.from,
		to: row.to,
		delta_requested: row.delta_requested,
		clamped: row.clamped,
		reason: row.reason,
		actor: row.actor,
		governance_blocked: row.governance_blocked ?? false,
		tool_call_id: row.tool_call_id,
		origin_node: row.origin_node,
	};
}

/** The same move, made by each engine, as the row each one leaves behind. */
async function bothWays(move: {
	delta: number;
	reason: string;
	actor: MutationLogEntry["actor"];
	blocked?: boolean;
	toolCallId?: string;
	originNode?: string;
}): Promise<{ old: Record<string, unknown>; now: Record<string, unknown> }> {
	const before = fresh();

	const legacy = fresh();
	applyMutation(legacy, ENVELOPES, {
		field: "mood.tone",
		delta: move.delta,
		reason: move.reason,
		actor: move.actor,
		...(move.blocked === undefined ? {} : { governanceBlocked: move.blocked }),
		...(move.toolCallId === undefined ? {} : { toolCallId: move.toolCallId }),
		...(move.originNode === undefined ? {} : { originNode: move.originNode }),
	});

	// A record from a previous call in the same test would make this the second row
	// rather than the first, and the comparison would quietly be against an older move.
	rmSync(recordPathFor(personaPath), { force: true });
	writeFileSync(statePath, JSON.stringify(before, null, 2));
	const provenance = {
		...(move.originNode === undefined ? {} : { node: move.originNode }),
		...(move.toolCallId === undefined ? {} : { toolCall: move.toolCallId }),
	};
	const { state } = await adjust(personaPath, statePath, ENVELOPES, authorOf(move.actor), {
		field: "mood.tone",
		delta: move.delta,
		reason: move.reason,
		...(move.blocked === undefined ? {} : { blocked: move.blocked }),
		...(Object.keys(provenance).length === 0 ? {} : { provenance }),
	});

	return { old: facts(legacy.mutation_log[0]!), now: facts(state.mutation_log[0]!) };
}

describe("a move the record writes", () => {
	it("leaves the same row an ordinary move used to leave", async () => {
		const { old, now } = await bothWays({ delta: 0.2, reason: "a good turn", actor: "actor-llm" });

		expect(now).toEqual(old);
	});

	it("leaves the same row when the envelope clamps it", async () => {
		// The case where `delta_requested` earns its keep: the schema says it may differ
		// from `to - from` precisely here, so this is where storing the wrong one shows.
		const { old, now } = await bothWays({ delta: 9, reason: "way past the ceiling", actor: "actor-llm" });

		expect(now.clamped).toBe(true);
		expect(now.delta_requested).toBe(9);
		expect(now).toEqual(old);
	});

	it("leaves the same row when governance refuses the move", async () => {
		// A refusal is recorded, not skipped, and it has to be recorded identically:
		// `from === to` with the attempt still visible.
		const { old, now } = await bothWays({
			delta: 0.3,
			reason: "not allowed",
			actor: "actor-llm",
			blocked: true,
		});

		expect(now.governance_blocked).toBe(true);
		expect(now.from).toBe(now.to);
		expect(now).toEqual(old);
	});

	it("leaves the same row for every actor the schema declares", async () => {
		for (const actor of [
			"actor-llm",
			"runtime-decay",
			"runtime-context",
			"human-operator",
			"judge-correction",
		] as const) {
			const { old, now } = await bothWays({ delta: -0.05, reason: "each one", actor });
			expect({ actor, ...now }).toEqual({ actor, ...old });
		}
	});

	it("carries the machine and the tool call the same way", async () => {
		const { old, now } = await bothWays({
			delta: 0.1,
			reason: "from a tool, on a machine",
			actor: "actor-llm",
			toolCallId: "call-77",
			originNode: "laptop",
		});

		expect(now.origin_node).toBe("laptop");
		expect(now.tool_call_id).toBe("call-77");
		expect(now).toEqual(old);
	});

	it("keeps a negative delta exactly, and does not round-trip it through a position", async () => {
		// `-0.2` became `-0.19999999999999996` when the entry kept the position and the
		// projection subtracted. Float noise inside a hash chain is noise nobody can
		// explain later, and a migration that changes the numbers is not a migration.
		const { now } = await bothWays({ delta: -0.2, reason: "exactly", actor: "actor-llm" });

		expect(now.delta_requested).toBe(-0.2);
	});
});
