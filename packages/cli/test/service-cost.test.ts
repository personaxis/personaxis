/**
 * The cost of a service run, and how a turn's end becomes a step's end.
 *
 * Work and governed ticks are added apart so the price of governing is a number of its own, which
 * is the comparison a demo of cost needs. A phase that never ran (a step that failed before its
 * tick) must not count as a phase that ran for free.
 */

import { describe, expect, it } from "vitest";

import { stepOutcomeOf, totalOf } from "../src/commands/service.js";

const phase = (ms: number, calls: number, p: number, c: number, unreported = 0) => ({ ms, calls, promptTokens: p, completionTokens: c, unreported });

describe("the cost of a service run", () => {
	it("adds each phase across steps, and keeps work and governing apart", () => {
		const total = totalOf([
			{ turn: phase(1000, 1, 100, 50), tick: phase(500, 1, 300, 20) },
			{ turn: phase(2000, 3, 200, 70), tick: phase(700, 1, 350, 30, 1) },
		]);
		expect(total.turn).toEqual(phase(3000, 4, 300, 120));
		expect(total.tick).toEqual(phase(1200, 2, 650, 50, 1));
	});

	it("does not count a phase that never ran", () => {
		const total = totalOf([{ turn: phase(1500, 1, 90, 0, 1), tick: null }]);
		expect(total.tick).toEqual(phase(0, 0, 0, 0));
		expect(total.turn.unreported).toBe(1);
	});
});

describe("how a turn's end becomes a step's end", () => {
	it("completes a step whose turn answered", () => {
		expect(stepOutcomeOf("answered", "done")).toEqual({ outcome: "completed", reason: null });
	});

	it("completes a turn that closed early on a ceiling, and says so", () => {
		const r = stepOutcomeOf("budget", "half of it");
		expect(r.outcome).toBe("completed");
		expect(r.reason).toMatch(/closed early \(budget\)/);
	});

	it("fails a turn that closed early with nothing to hand on", () => {
		expect(stepOutcomeOf("stopped", "  ").outcome).toBe("failed");
	});

	it("fails every end that cut the work short, so the next step never builds on it", () => {
		for (const end of ["refused", "interrupted", "empty", "failed", "abandoned"] as const) {
			// Even with text: a refused turn's partial answer is not the delivery.
			expect(stepOutcomeOf(end, "some text").outcome).toBe("failed");
		}
	});
});
