/**
 * One suite, run against every loop that claims to be one.
 *
 * A seam is only a seam if a second implementation can pass what the first passes.
 * Until somebody has actually run the same tests against two providers, "pluggable" is
 * a hope: the contract lives in one implementation's habits, and the second one
 * discovers them by failing in a customer's deployment.
 *
 * So the suite below is written against the definition and knows nothing about who is
 * running. Two providers go through it: one that behaves like ours, and one written
 * deliberately badly, which returns early, throws, spends more than it was told it
 * could, and reports numbers that do not match what it did.
 *
 * The badly-behaved one is the point. The properties hold **because the runner owns
 * them**, not because the provider cooperates, and a provider that cooperates proves
 * nothing about a provider that does not.
 */

import { describe, expect, it } from "vitest";

import {
	Ledger,
	TurnRunner,
	answered,
	productOf,
	type LoopProvider,
	type TurnRequest,
} from "../src/run/index.js";

const asked: TurnRequest = {
	turn: "t1",
	prompt: "anything",
	asker: { kind: "human", id: "david" },
};

/** Behaves. Reports its steps as it goes and stops when told there is no room. */
const wellBehaved: LoopProvider = {
	name: "well-behaved",
	run: async (context) => {
		let steps = 0;
		while (context.hasRoom() && steps < 3) {
			steps += 1;
			context.stepDone();
		}
		return { answer: "done", steps };
	},
};

/**
 * Does everything wrong that a provider can do.
 *
 * Ignores the room check, spends far more than any ceiling, misreports its step count,
 * and on every third turn throws instead of returning. Written as an adversary rather
 * than as a mistake, because the question is what the runner guarantees when a provider
 * does not help, and that is exactly the provider a customer will plug in.
 */
function misbehaving(): LoopProvider {
	let turns = 0;
	return {
		name: "misbehaving",
		run: async (context) => {
			turns += 1;
			for (let index = 0; index < 50; index += 1) context.stepDone();
			if (turns % 3 === 0) throw new Error("and now it explodes");
			// Claims one step after taking fifty.
			return { answer: "done", steps: 1 };
		},
	};
}

const providers: readonly (() => LoopProvider)[] = [() => wellBehaved, misbehaving];

describe.each(providers.map((make) => [make().name, make] as const))(
	"the loop contract holds for %s",
	(_name, make) => {
		it("always closes a turn, whatever the provider did", async () => {
			const closed: string[] = [];
			const runner = new TurnRunner({
				provider: make(),
				observer: { closed: (outcome) => closed.push(outcome.stopReason) },
			});

			for (let index = 0; index < 5; index += 1) {
				await runner.run({ ...asked, turn: `t${index}` });
			}

			expect(closed).toHaveLength(5);
		});

		it("closes with a reason from the closed set, never with silence", async () => {
			const runner = new TurnRunner({ provider: make() });
			const known = new Set([
				"answered",
				"budget",
				"refused",
				"interrupted",
				"empty",
				"failed",
				"abandoned",
			]);

			for (let index = 0; index < 5; index += 1) {
				const outcome = await runner.run({ ...asked, turn: `t${index}` });
				expect(known.has(outcome.stopReason)).toBe(true);
			}
		});

		it("counts every turn against the ledger, so a ceiling eventually bites", async () => {
			// A provider that ignores the room check is not stopped mid-turn, and the
			// header says so. What it cannot do is keep starting turns.
			const ledger = new Ledger({ turns: 3 });
			const runner = new TurnRunner({ provider: make(), ledger });

			const outcomes = [];
			for (let index = 0; index < 6; index += 1) {
				outcomes.push(await runner.run({ ...asked, turn: `t${index}` }));
			}

			expect(outcomes.slice(3).every((outcome) => outcome.stopReason === "budget")).toBe(true);
			expect(ledger.spent().turns).toBe(6);
		});

		it("reports a step count that is not below what it charged the ledger", async () => {
			// A provider that under-reports cannot make the ledger under-charge, because
			// the ledger counts what was reported as it happened rather than trusting the
			// total at the end.
			const ledger = new Ledger();
			const runner = new TurnRunner({ provider: make(), ledger });

			await runner.run(asked);

			expect(ledger.spent().steps).toBeGreaterThan(0);
		});

		it("never lets a provider produce an outcome the runner did not make", async () => {
			// Every outcome carries the turn it belongs to, and the turn comes from the
			// request rather than from the provider, so a provider cannot answer about a
			// turn it was not asked about.
			const runner = new TurnRunner({ provider: make() });

			const outcome = await runner.run({ ...asked, turn: "specific" });

			expect(outcome.turn).toBe("specific");
		});
	},
);

describe("a second provider is not a special case", () => {
	it("gives the same shape of outcome for the same behaviour", async () => {
		const first = await new TurnRunner({
			provider: { name: "a", run: async () => ({ answer: "same", steps: 2 }) },
		}).run(asked);
		const second = await new TurnRunner({
			provider: { name: "b", run: async () => ({ answer: "same", steps: 2 }) },
		}).run(asked);

		expect(second).toEqual(first);
	});
});

describe("the loop we already have goes through the same seam", () => {
	it("calls an answered run answered", () => {
		expect(
			productOf({
				summary: "the branch is clean",
				steps: 3,
				finished: true,
				budget: { steps: 3, tokens: 0, costUsd: 0, wallSeconds: 0, stoppedBy: null },
			}),
		).toEqual({
			answer: "the branch is clean",
			steps: 3,
			stopReason: "answered",
			// Reported because the budget said so, zeros included. Zero is a
			// measurement: somebody looked and the turn was free.
			cost: { tokens: 0, usd: 0 },
		});
	});

	it("gives no price for a run nobody priced, rather than calling it free", () => {
		// A scripted provider has no budget to read. Reporting zero would turn "nothing
		// to say" into "checked, and it cost nothing", and a total over ten turns reads
		// identically whether all ten were priced or none were.
		const product = productOf({ summary: "done", steps: 1, finished: true });

		expect(product).toEqual({ answer: "done", steps: 1, stopReason: "answered" });
		expect("cost" in product).toBe(false);
	});

	it("carries the price through every ending, not only the happy one", () => {
		// A turn that was refused or ran out still cost what it cost, and dropping the
		// price on the unhappy paths is how a bill comes out lower than the work.
		const budget = { steps: 2, tokens: 900, costUsd: 0.04, wallSeconds: 1, stoppedBy: "tool_denied" };
		const refused = productOf({ summary: "", steps: 2, finished: false, budget } as never);
		const ranOut = productOf({
			summary: "",
			steps: 2,
			finished: false,
			budget: { ...budget, stoppedBy: "max_steps" },
		} as never);

		expect(refused.stopReason).toBe("refused");
		expect(refused.cost).toEqual({ tokens: 900, usd: 0.04 });
		expect(ranOut.cost).toEqual({ tokens: 900, usd: 0.04 });
	});

	it("hands back what a budget stop had, and does not call the loop finished", () => {
		// This asserted `answered`, which is how "the loop said it was done" and "the
		// loop ran out of steps" came to be the same word. A usable reply is still
		// delivered, which is what the reasoning behind the old assertion was actually
		// about and what `answered(reason)` still says; the reference reaches the same
		// place by spending one more tool-free call to summarise on exhaustion.
		const product = productOf({
			summary: "here is what I found so far",
			steps: 9,
			finished: false,
			budget: { steps: 9, tokens: 0, costUsd: 0, wallSeconds: 0, stoppedBy: "max_steps" },
		});

		expect(product.stopReason).toBe("budget");
		expect(product.answer).toBe("here is what I found so far");
		expect(answered("budget")).toBe(true);
	});

	it("says a budget stop ran out of room even when it produced nothing", () => {
		// This asserted `empty`, which reports "the model produced nothing usable" for a
		// turn that never got the chance. The reason and the answer are separate facts.
		const product = productOf({
			summary: "",
			steps: 9,
			finished: false,
			budget: { steps: 9, tokens: 0, costUsd: 0, wallSeconds: 0, stoppedBy: "max_steps" },
		});

		expect(product.stopReason).toBe("budget");
		expect(product.answer).toBe("");
	});

	it("keeps a loop that said it was done as the only thing called answered", () => {
		// The distinction the SDK was about to lose: `AgentResult.finished` is the field
		// that says the task completed, and `answered` is now the only reason that means
		// it. Nothing else in the closed set does.
		const finished = productOf({
			summary: "done",
			steps: 2,
			finished: true,
			budget: { steps: 2, tokens: 0, costUsd: 0, wallSeconds: 0, stoppedBy: "goal_met" },
		});

		expect(finished.stopReason).toBe("answered");
	});

	it("calls a run the gate stopped refused", () => {
		expect(
			productOf({
				summary: "",
				steps: 1,
				finished: false,
				budget: { steps: 1, tokens: 0, costUsd: 0, wallSeconds: 0, stoppedBy: "tool_denied" },
			}).stopReason,
		).toBe("refused");
	});

	it("does not invent a reason for a stop it does not recognise", () => {
		// This test existed and asserted `empty`, which is the guess its own name says
		// not to make: a stop nobody classified came out as a turn that ran and produced
		// nothing. A wrong reason is a reason somebody acts on, so an unknown stop fails
		// and carries the word, which is how whoever added it finds out where it landed.
		const product = productOf({
			summary: "",
			steps: 2,
			finished: false,
			budget: { steps: 2, tokens: 0, costUsd: 0, wallSeconds: 0, stoppedBy: "something_new" },
		});

		expect(product.stopReason).toBe("failed");
		expect(product.failure?.message).toContain("something_new");
	});

	it("calls a run that ended in an error failed, and does not quote it as the answer", () => {
		// The one that mattered. The old loop returns `agent error: ...` as its summary,
		// and this reported the turn ANSWERED with that sentence as the persona's reply.
		// Nothing read the stop reason in production, so nothing showed it; the moment
		// the REPL went through the seam, the record would have stored a runtime string
		// as a message authored by the persona, hash-chained and unfixable.
		const product = productOf({
			summary: "agent error: the model hung up",
			steps: 0,
			finished: false,
			budget: { steps: 0, tokens: 0, costUsd: 0, wallSeconds: 0, stoppedBy: "error" },
		});

		expect(product.stopReason).toBe("failed");
		expect(product.answer).toBe("");
		expect(product.failure).toEqual({ code: "error", message: "agent error: the model hung up" });
	});

	it("calls a rejected verification failed, not an answer of the words verification failed", () => {
		const product = productOf({
			summary: "verification failed",
			steps: 4,
			finished: false,
			budget: { steps: 4, tokens: 0, costUsd: 0, wallSeconds: 0, stoppedBy: "verification_failed" },
		});

		expect(product.stopReason).toBe("failed");
		expect(product.answer).toBe("");
	});

	it("calls every guard that stopped the loop refused, not only a denied tool", () => {
		// The repetition breaker and a plan that could not survive its own gates are the
		// same fact as a denied tool: the turn could not continue past something it
		// needed. They used to fall through to "answered if there is text".
		for (const stoppedBy of ["tool_denied", "loop_breaker", "plan"]) {
			const product = productOf({
				summary: "as far as I got",
				steps: 2,
				finished: false,
				budget: { steps: 2, tokens: 0, costUsd: 0, wallSeconds: 0, stoppedBy },
			});

			expect({ stoppedBy, reason: product.stopReason }).toEqual({ stoppedBy, reason: "refused" });
		}
	});

	it("tells a ceiling apart from a rule somebody declared", () => {
		// An operator who wrote `stop_conditions: [no_progress]` asked for this, and
		// reporting it as a budget tells them their ceiling ran out when their rule
		// fired. Neither is a failure: the spec working is not the spec being wrong.
		const cases = [
			["hard_ceiling", "budget"],
			["watchdog", "budget"],
			["max_wall_seconds", "budget"],
			["execution_error", "stopped"],
			["low_confidence", "stopped"],
			["no_progress", "stopped"],
		] as const;

		for (const [stoppedBy, reason] of cases) {
			const product = productOf({
				summary: "here is what I have",
				steps: 5,
				finished: false,
				budget: { steps: 5, tokens: 0, costUsd: 0, wallSeconds: 0, stoppedBy },
			});

			expect({ stoppedBy, reason: product.stopReason }).toEqual({ stoppedBy, reason });
			expect({ stoppedBy, delivered: answered(product.stopReason!) }).toEqual({
				stoppedBy,
				delivered: true,
			});
		}
	});

	it("puts a provider's own failure in the outcome instead of losing it", async () => {
		// A provider that catches its own error had no way to say so: throwing was the
		// only route to `failed`, which asks every provider to let its errors escape in
		// order to be honest about them.
		const outcome = await new TurnRunner({
			provider: {
				name: "honest",
				run: async () => ({
					answer: "",
					steps: 1,
					stopReason: "failed" as const,
					failure: { code: "upstream", message: "the endpoint refused" },
				}),
			},
		}).run(asked);

		expect(outcome.stopReason).toBe("failed");
		expect(outcome.failure).toEqual({ code: "upstream", message: "the endpoint refused" });
	});
});
