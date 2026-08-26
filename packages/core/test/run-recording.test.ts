/**
 * A turn ends up in the record, on every route out of it.
 *
 * This is what lets the old agent be retired. The REPL reads its conversation off
 * `PersonaAgent.lastMessages` and its cost off `result.budget`, so the agent could not
 * go while it was the only thing that knew either. Both are facts about a turn and the
 * record is where a persona's facts live, so once they are written the REPL reads a
 * projection instead of holding a loop.
 *
 * The endings are what these mostly check. A happy turn writing itself down is easy;
 * the ones that matter are the turn that failed, the turn that was refused before it
 * began, and the turn a provider walked away from, because those are the ones a
 * transcript quietly loses and a reader fills in with a guess.
 */

import { describe, expect, it } from "vitest";

import { Ledger } from "../src/run/budget.js";
import { recordTurns } from "../src/run/recording.js";
import { TurnRunner } from "../src/run/service.js";
import { Journal } from "../src/record/journal.js";
import type { RecordBody } from "../src/record/entry.js";
import type { TurnRequest } from "../src/run/vocabulary.js";

const ASKED: TurnRequest = {
	turn: "t1",
	prompt: "how is the branch",
	asker: { kind: "human", id: "david" },
};

function running(provider: Parameters<typeof runnerWith>[0], ledger?: Ledger) {
	return runnerWith(provider, ledger);
}

function runnerWith(
	provider: { name: string; run: (context: never) => Promise<never> } | { name: string; run: unknown },
	ledger?: Ledger,
): { runner: TurnRunner; journal: Journal } {
	const journal = new Journal({});
	const runner = new TurnRunner({
		provider: provider as never,
		observer: recordTurns({ journal }),
		...(ledger ? { ledger } : {}),
	});
	return { runner, journal };
}

/** The bodies written, in order, so a test can say what a reader would meet. */
function bodies(journal: Journal): RecordBody[] {
	return journal.all().map((entry) => entry.body);
}

describe("a turn that went well", () => {
	it("writes what was asked, what was said, and how it ended", async () => {
		const { runner, journal } = running({
			name: "scripted",
			run: async () => ({ answer: "clean", steps: 2 }),
		} as never);

		await runner.run(ASKED);

		expect(bodies(journal)).toEqual([
			{ type: "turn-open", turn: "t1", prompt: "how is the branch" },
			{ type: "message", turn: "t1", role: "assistant", text: "clean" },
			{ type: "turn-close", turn: "t1", outcome: "answered", synthetic: false, spent: { steps: 2 } },
		]);
	});

	it("attributes the question to whoever asked and the answer to the persona", async () => {
		// An answer credited to the person who asked for it is the forgery the author
		// invariant exists to prevent, committed by the thing that writes the record.
		const { runner, journal } = running({
			name: "scripted",
			run: async () => ({ answer: "clean", steps: 1 }),
		} as never);

		await runner.run(ASKED);
		const [opened, said, closed] = journal.all();

		expect(opened!.author).toEqual({ kind: "human", id: "david" });
		// `self`, not the persona's canonical id. A record belongs to one persona, every
		// coordinate entry in it already says `self`, and a second spelling for one actor
		// in one chain is the drift the author vocabulary exists to end.
		expect(said!.author).toEqual({ kind: "persona", id: "self" });
		// The runtime ended the turn; the persona did not decide it was over.
		expect(closed!.author.kind).toBe("runtime");
	});

	it("writes a price when there is one, and none when nobody priced it", async () => {
		const priced = running({
			name: "priced",
			run: async () => ({ answer: "ok", steps: 1, cost: { tokens: 420, usd: 0.02 } }),
		} as never);
		await priced.runner.run(ASKED);

		const free = running({ name: "scripted", run: async () => ({ answer: "ok", steps: 1 }) } as never);
		await free.runner.run(ASKED);

		const closeOf = (j: Journal) =>
			bodies(j).find((b) => b.type === "turn-close") as Extract<RecordBody, { type: "turn-close" }>;

		expect(closeOf(priced.journal).spent).toEqual({ steps: 1, tokens: 420, usd: 0.02 });
		// Steps are always known; a price is not. Zero would say somebody looked.
		expect(closeOf(free.journal).spent).toEqual({ steps: 1 });
	});

	it("adds up to a total the record can be asked for", async () => {
		const { runner, journal } = running({
			name: "priced",
			run: async () => ({ answer: "ok", steps: 2, cost: { tokens: 100, usd: 0.01 } }),
		} as never);

		await runner.run(ASKED);
		await runner.run({ ...ASKED, turn: "t2" });

		const state = journal.state();
		expect(state.ok).toBe(true);
		if (!state.ok) return;
		expect(state.state.spent).toEqual({ steps: 4, tokens: 200, usd: 0.02, priced: 2 });
		expect(state.state.turnCount).toBe(2);
	});
});

describe("a turn that did not", () => {
	it("writes the ending of a turn whose provider threw", async () => {
		const { runner, journal } = running({
			name: "broken",
			run: async () => {
				throw new Error("the model hung up");
			},
		} as never);

		await runner.run(ASKED);
		const close = bodies(journal).find((b) => b.type === "turn-close");

		expect(close).toEqual({
			type: "turn-close",
			turn: "t1",
			outcome: "failed",
			synthetic: false,
			spent: { steps: 0 },
		});
		// Nothing was said, so nothing is written as having been said.
		expect(bodies(journal).some((b) => b.type === "message")).toBe(false);
	});

	it("marks a turn nobody closed as synthetic, because the runtime closed it", async () => {
		// A close the runtime writes for a loop that walked away is not the loop's
		// ending. Recording it as though it were makes a transcript claim the persona
		// decided something it never decided.
		const { runner, journal } = running({
			name: "silent",
			run: async () => ({ answer: "", steps: 1 }),
		} as never);

		await runner.run(ASKED);
		const close = bodies(journal).find((b) => b.type === "turn-close") as Extract<
			RecordBody,
			{ type: "turn-close" }
		>;

		expect(close.outcome).toBe("abandoned");
		expect(close.synthetic).toBe(true);
	});

	it("writes a turn refused before it began, so a refusal is not a gap", async () => {
		// The runner refuses without ever calling the provider. A turn that leaves no
		// trace is one a reader has to guess about, and the guess is always that nothing
		// happened.
		const ledger = new Ledger({ turns: 1 });
		const { runner, journal } = running(
			{ name: "scripted", run: async () => ({ answer: "ok", steps: 1 }) } as never,
			ledger,
		);

		await runner.run(ASKED);
		await runner.run({ ...ASKED, turn: "t2" });

		const closes = bodies(journal).filter((b) => b.type === "turn-close") as Extract<
			RecordBody,
			{ type: "turn-close" }
		>[];
		expect(closes).toHaveLength(2);
		expect(closes[1]!.outcome).toBe("budget");
		expect(closes[1]!.spent).toEqual({ steps: 0 });

		// And it opened, so the record does not contain an ending for something that
		// never started. The refusal used to be written as a close on its own.
		const opens = bodies(journal).filter((b) => b.type === "turn-open");
		expect(opens).toHaveLength(2);
	});

	it("leaves a chain that verifies whatever happened", async () => {
		const { runner, journal } = running({
			name: "erratic",
			run: async () => {
				throw new Error("no");
			},
		} as never);

		await runner.run(ASKED);
		await runner.run({ ...ASKED, turn: "t2" });

		expect(journal.verify().ok).toBe(true);
	});
});
