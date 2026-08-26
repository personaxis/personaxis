/**
 * What the loop seam promises, checked.
 *
 * The one that matters is the first group. A provider cannot skip closing a turn,
 * because a provider never performs the close. Everything else is arrangement.
 */

import { describe, expect, it, vi } from "vitest";

import {
	Ledger,
	TurnRunner,
	answered,
	breakerGuard,
	describeRoom,
	nudgeFor,
	type LoopProvider,
	type TurnOutcome,
	type TurnRequest,
} from "../src/run/index.js";
import { LoopBreaker, toolSignature } from "../src/loop-breaker.js";
import { runGuards, freezeCall } from "../src/gate/index.js";

const asked: TurnRequest = {
	turn: "t1",
	prompt: "what is the state of the branch",
	asker: { kind: "human", id: "david" },
};

function provider(run: LoopProvider["run"], name = "test"): LoopProvider {
	return { name, run };
}

function collect(): { observer: { opened: ReturnType<typeof vi.fn>; closed: ReturnType<typeof vi.fn> }; closes: TurnOutcome[] } {
	const closes: TurnOutcome[] = [];
	return {
		observer: {
			opened: vi.fn(),
			closed: vi.fn((outcome: TurnOutcome) => {
				closes.push(outcome);
			}),
		},
		closes,
	};
}

describe("every turn closes, on every path", () => {
	it("closes a turn that answered", async () => {
		const { observer, closes } = collect();
		const runner = new TurnRunner({
			provider: provider(async () => ({ answer: "clean", steps: 2 })),
			observer,
		});

		const outcome = await runner.run(asked);

		expect(outcome.stopReason).toBe("answered");
		expect(closes).toHaveLength(1);
	});

	it("closes a turn whose provider threw, and says what failed", async () => {
		const { observer, closes } = collect();
		const runner = new TurnRunner({
			provider: provider(async () => {
				throw new Error("the model hung up");
			}),
			observer,
		});

		const outcome = await runner.run(asked);

		expect(outcome.stopReason).toBe("failed");
		expect(outcome.failure?.message).toBe("the model hung up");
		expect(closes).toHaveLength(1);
	});

	it("closes a turn whose provider returned nothing, rather than leaving it open", async () => {
		// The reference's contract says a delivered answer must close the durable turn,
		// and twenty-five early returns skip the function that does it. Here a provider
		// that returns without an answer is closed as abandoned, which is a stop reason
		// like any other rather than a silence.
		const { observer, closes } = collect();
		const runner = new TurnRunner({
			provider: provider(async () => ({ answer: "", steps: 1 })),
			observer,
		});

		const outcome = await runner.run(asked);

		expect(outcome.stopReason).toBe("abandoned");
		expect(outcome.failure?.code).toBe("abandoned");
		expect(closes).toHaveLength(1);
	});

	it("closes exactly once, never twice", async () => {
		const { observer } = collect();
		const runner = new TurnRunner({
			provider: provider(async () => ({ answer: "x", steps: 1 })),
			observer,
		});

		await runner.run(asked);

		expect(observer.closed).toHaveBeenCalledTimes(1);
	});

	it("opens a turn it then refuses, so the refusal is not an ending with no beginning", async () => {
		// This used to assert the opposite, on the reasoning that a turn never allowed to
		// begin is not a turn that ended. The line after it asserted that the close still
		// fired, so the record got an ending for something that, as far as it said, never
		// started. Either both or neither, and neither is wrong for the same reason a
		// blocked mutation is written down rather than skipped: the refusal is the fact
		// worth keeping. Somebody asked and was told no, and a record that keeps only the
		// no cannot say what was refused.
		const { observer } = collect();
		const runner = new TurnRunner({
			provider: provider(async () => ({ answer: "x", steps: 1 })),
			ledger: new Ledger({ turns: 0 }),
			observer,
		});

		const outcome = await runner.run(asked);

		expect(outcome.stopReason).toBe("budget");
		expect(observer.opened).toHaveBeenCalledTimes(1);
		expect(observer.closed).toHaveBeenCalledTimes(1);
	});

	it("gives a provider no way to end a turn itself", () => {
		// The guarantee, and it is structural. A provider is handed a context with a
		// prompt and a room check, and nothing on it can close anything.
		let seen: string[] = [];
		const runner = new TurnRunner({
			provider: provider(async (context) => {
				seen = Object.keys(context);
				return { answer: "x", steps: 1 };
			}),
		});

		return runner.run(asked).then(() => {
			expect(seen).toEqual(["request", "hasRoom", "stepDone"]);
		});
	});
});

describe("the budget belongs to the tree and is charged when the work happened", () => {
	it("charges nothing for a step that never reached the provider", async () => {
		// Nothing is charged until something came back, so there is nothing to give
		// back. The reference refunds in seven places and its own comment records the
		// leak that follows.
		const ledger = new Ledger({ steps: 10 });
		const runner = new TurnRunner({
			provider: provider(async () => {
				throw new Error("never got there");
			}),
			ledger,
		});

		await runner.run(asked);

		expect(ledger.spent().steps).toBe(0);
	});

	it("reports the steps a failed turn took, rather than denying work it charged for", async () => {
		// Two numbers about one fact with nothing comparing them is exactly the
		// divergence the record exists to make impossible.
		const ledger = new Ledger();
		const runner = new TurnRunner({
			provider: provider(async (context) => {
				context.stepDone();
				context.stepDone();
				throw new Error("and then it broke");
			}),
			ledger,
		});

		const outcome = await runner.run(asked);

		expect(outcome.steps).toBe(2);
		expect(ledger.spent().steps).toBe(2);
	});

	it("charges for steps that came back, including the ones that failed", async () => {
		const ledger = new Ledger();
		const runner = new TurnRunner({
			provider: provider(async () => ({ answer: "", steps: 3, stopReason: "empty" })),
			ledger,
		});

		await runner.run(asked);

		expect(ledger.spent().steps).toBe(3);
	});

	it("counts a child's spend against the same ceiling as its parent", async () => {
		// A tenant limit a delegation steps over is not a limit.
		const ledger = new Ledger({ steps: 4 });
		const spender = provider(async (context) => {
			let steps = 0;
			while (context.hasRoom() && steps < 3) {
				steps += 1;
				context.stepDone();
			}
			return { answer: "done", steps };
		});
		const parent = new TurnRunner({ provider: spender, ledger });
		const child = new TurnRunner({ provider: spender, ledger: ledger.forChild() });

		await parent.run(asked);
		await child.run({ ...asked, turn: "t2" });
		const third = await child.run({ ...asked, turn: "t3" });

		// Parent took three, the child got one and stopped because the ledger is the
		// same one, and the third turn is refused before it opens.
		expect(ledger.spent().steps).toBe(4);
		expect(third.stopReason).toBe("budget");
		expect(third.failure?.message).toContain("delegation tree");
	});

	it("charges a reported step once, not twice", async () => {
		const ledger = new Ledger();
		const runner = new TurnRunner({
			provider: provider(async (context) => {
				context.stepDone();
				context.stepDone();
				return { answer: "x", steps: 2 };
			}),
			ledger,
		});

		await runner.run(asked);

		expect(ledger.spent().steps).toBe(2);
	});

	it("charges at the end for a provider that reported nothing as it went", async () => {
		const ledger = new Ledger();
		const runner = new TurnRunner({
			provider: provider(async () => ({ answer: "x", steps: 5 })),
			ledger,
		});

		await runner.run(asked);

		expect(ledger.spent().steps).toBe(5);
	});

	it("tells the provider whether there is room without charging it", async () => {
		const ledger = new Ledger({ steps: 1 });
		let roomAtStart: boolean | undefined;
		const runner = new TurnRunner({
			provider: provider(async (context) => {
				roomAtStart = context.hasRoom();
				return { answer: "x", steps: 1 };
			}),
			ledger,
		});

		await runner.run(asked);

		expect(roomAtStart).toBe(true);
		expect(ledger.spent().steps).toBe(1);
	});

	it("says which ceiling ran out and that it is the tree's", () => {
		const ledger = new Ledger({ turns: 1 });
		ledger.chargeTurn();

		expect(describeRoom(ledger.room())).toContain("1 of 1 turns");
		expect(describeRoom(ledger.room())).toContain("delegation tree");
	});

	it("is unlimited when no ceiling was declared, which is a choice and not an oversight", () => {
		const ledger = new Ledger();
		for (let index = 0; index < 1000; index += 1) ledger.chargeStep();

		expect(ledger.room().ok).toBe(true);
	});
});

describe("the breaker refuses and advises through different doors", () => {
	function failing(times: number): LoopBreaker {
		const breaker = new LoopBreaker();
		for (let index = 0; index < times; index += 1) {
			breaker.record({ producedWork: false, failingSignature: toolSignature("shell", { cmd: "x" }) });
		}
		return breaker;
	}

	it("refuses the next call once the trailing run says stop", () => {
		const breaker = failing(4);
		const result = runGuards(
			[breakerGuard(breaker)],
			freezeCall({ tool: "shell", argsText: "x", turn: "t1" }),
		);

		expect(result.verdict).toBe("deny");
		expect(result.contributions[0]!.rule).toBe("loop_breaker");
	});

	it("says nothing while the run is healthy", () => {
		const breaker = new LoopBreaker();
		breaker.record({ producedWork: true, failingSignature: null });

		expect(breakerGuard(breaker).check(freezeCall({ tool: "t", argsText: "", turn: "t1" }))).toBeUndefined();
	});

	it("turns a nudge into something to add, never into a verdict", () => {
		// A patched result makes the logged result lie about what the tool returned, so
		// the advisory half produces an addition and touches nothing.
		const breaker = failing(3);

		const nudge = nudgeFor(breaker.assess());

		expect(nudge?.text).toContain("change approach");
		expect(breakerGuard(breaker).check(freezeCall({ tool: "t", argsText: "", turn: "t1" }))).toBeUndefined();
	});

	it("stamps the author on what it adds, because an unlabelled message reads as the person's", () => {
		const nudge = nudgeFor(failing(3).assess());

		expect(nudge?.author).toMatchObject({ kind: "runtime", mechanism: "loop-breaker" });
	});

	it("has nothing to add when the verdict is not a nudge", () => {
		expect(nudgeFor({ action: "continue" })).toBeUndefined();
		expect(nudgeFor({ action: "stop", reason: "x" })).toBeUndefined();
	});
});

describe("consumers never see the provider", () => {
	it("names which loop is running without handing it over", async () => {
		const runner = new TurnRunner({
			provider: provider(async () => ({ answer: "x", steps: 1 }), "default"),
		});

		// `#provider` is genuinely private, not TypeScript's compile-time courtesy, so
		// this is a claim about runtime rather than about the type checker.
		expect(runner.providerName).toBe("default");
		expect(Object.keys(runner)).not.toContain("provider");
		expect(JSON.stringify(runner)).not.toContain("default");
	});

	it("gives the same outcomes through a different provider", async () => {
		// The point of the seam: a swap is a configuration change, and the shape of what
		// comes out does not depend on who produced it.
		const outcomes = await Promise.all(
			["ours", "theirs"].map((name) =>
				new TurnRunner({
					provider: provider(async () => ({ answer: "same", steps: 2 }), name),
				}).run(asked),
			),
		);

		expect(outcomes[0]).toEqual(outcomes[1]);
	});
});

describe("a budget stop still counts as having answered", () => {
	it("treats budget as an answer and abandoned as not", () => {
		// A turn that ran out of steps closes with what it had, and delivering that
		// beats delivering nothing.
		expect(answered("budget")).toBe(true);
		expect(answered("answered")).toBe(true);
		expect(answered("abandoned")).toBe(false);
		expect(answered("failed")).toBe(false);
	});
});
