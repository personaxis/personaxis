/**
 * The compaction a person actually meets: a conversation that fills up across turns.
 *
 * ## Why this did not exist
 *
 * Two mechanisms reach a person: `/compact`, which they ask for, and the automatic one that fires between
 * turns at 0,85. The summarising itself is covered in `core` against a scripted model (threshold, the
 * preserved system block, a summariser that throws). What nothing covered was either ENTRY POINT, over a
 * conversation that accumulates, which is the only way a person ever gets there.
 *
 * The reason is mechanical and worth writing down: `maybeAutoCompact` resolved its model through `llmConfig`,
 * which answers from the persona and the project config and carries no `fetchImpl`. Nothing could drive it
 * without a live endpoint, so the existing test could only assert the two ways it does NOTHING: no model, and
 * below the threshold. A path that cannot be driven is a path nobody checks.
 *
 * ## What is asserted here
 *
 * That a session which crosses the threshold gets its history summarised and KEEPS working: the leading
 * system block survives, the recent turns survive, the older ones become one summary, and the meter drops.
 * The single-turn bench runs never show this: a bench turn starts with a fresh meter, and a conversation shares one across every turn of the session.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContextMeter } from "@personaxis/core";
import { makeCtx } from "../src/repl/session.js";
import { maybeAutoCompact } from "../src/repl/turn.js";
import { writeTestPersona } from "./helpers/test-persona.js";

let dir: string;
let home: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-conv-compact-"));
	home = process.env.PERSONAXIS_HOME;
	process.env.PERSONAXIS_HOME = join(dir, "home");
});
afterEach(() => {
	if (home === undefined) delete process.env.PERSONAXIS_HOME;
	else process.env.PERSONAXIS_HOME = home;
	rmSync(dir, { recursive: true, force: true });
});

/** A summariser that answers, so the compaction actually happens rather than failing open. */
const summariser = {
	endpoint: "http://x/v1",
	model: "m",
	fetchImpl: (async () => ({
		ok: true,
		status: 200,
		json: async () => ({ choices: [{ message: { content: "earlier: the game design and the fixes agreed so far" } }] }),
	})) as unknown as typeof fetch,
};

/** The window this works against. Small, so an ordinary conversation fills it. */
const WINDOW = 1_000;

/**
 * A session after several turns: what a person and a persona said, back and forth.
 *
 * Not filler. This is the shape of a real working conversation: talk, run something, correct it, change subject. What makes
 * it a conversation rather than a turn is that all of it sits in ONE context, which is why the meter fills.
 */
function conversing(turns: number): { role: string; content: string }[] {
	const said = [
		["user", "I want a small arcade game about a cat crossing a road"],
		["assistant", "Here is the design: one road, three lanes, a timer"],
		["user", "the cat moves too slowly, fix that"],
		["assistant", "Raised the step to 24 pixels and shortened the hop"],
		["user", "now tell me something else, how would you test it"],
		["assistant", "Run it for ten seconds and watch for a thrown error"],
	];
	return Array.from({ length: turns }, (_, index) => {
		const [role, content] = said[index % said.length]!;
		return { role: role!, content: `${content} (${index})` };
	});
}

function sessionAt(fraction: number, turns: number) {
	const meter = new ContextMeter(WINDOW);
	const ctx = makeCtx(writeTestPersona(dir, "Clio"), meter);
	ctx.conversation = conversing(turns) as never;
	meter.used = Math.round(WINDOW * fraction);
	const shown: string[] = [];
	ctx.out = (text: string) => void shown.push(text);
	return { ctx, meter, shown };
}

describe("the compaction a conversation actually reaches", () => {
	it("summarises the older turns once the session crosses the threshold, and keeps the recent ones", async () => {
		const { ctx, meter } = sessionAt(0.9, 30);
		const before = ctx.conversation.length;

		await maybeAutoCompact(ctx, 0.85, summariser);

		// Fewer messages than it had, and the summary is among them: the history was condensed, not dropped.
		expect(ctx.conversation.length).toBeLessThan(before);
		expect(ctx.conversation.some((m) => String(m.content).includes("earlier: the game design"))).toBe(true);
		// The last things said are still there verbatim: a person who just asked something still has it.
		expect(ctx.conversation.some((m) => String(m.content).includes("(29)"))).toBe(true);
		// And the context it measures against went down, which is the entire point of doing it.
		expect(meter.used).toBeLessThan(Math.round(WINDOW * 0.9));
	});

	/**
	 * Below the threshold nothing is touched, and breaking this takes TWO patches, not one.
	 *
	 * The conversation is guarded twice in series: `maybeAutoCompact` checks the meter before it calls, and
	 * `compactMessages` checks it again inside. Removing either guard on its own leaves this green, which
	 * reads like a test that watches nothing; removing BOTH turns it red. So the invariant is watched, and
	 * the redundancy belongs to the product rather than being a hole here. Measured 2026-09-18, five
	 * controls in one run against a rebuilt `core` dist: A and B stay green alone, C, D and E fall.
	 */
	it("leaves a conversation alone while it still fits, however long it looks", async () => {
		const { ctx } = sessionAt(0.4, 30);
		const before = [...ctx.conversation];

		await maybeAutoCompact(ctx, 0.85, summariser);

		expect(ctx.conversation).toEqual(before);
	});

	it("says it out loud, because a conversation that was rewritten behind a person's back is not honest", async () => {
		const { ctx, shown } = sessionAt(0.9, 30);

		await maybeAutoCompact(ctx, 0.85, summariser);

		expect(shown.join("\n").toLowerCase()).toContain("compact");
	});
});
