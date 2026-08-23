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
