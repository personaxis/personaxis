/**
 * The cost of a service run, added up per phase: answers, bookkeeping and governed ticks.
 *
 * Kept apart so the price of governing is a number of its own, which is the comparison a demo of
 * cost needs. A phase that never ran (a step that failed before its tick) must not count as a
 * phase that ran for free.
 */

import { describe, expect, it } from "vitest";

import { totalOf } from "../src/commands/service.js";

const phase = (ms: number, calls: number, p: number, c: number, unreported = 0) => ({ ms, calls, promptTokens: p, completionTokens: c, unreported });

describe("the cost of a service run", () => {
	it("adds each phase across steps, and keeps the three apart", () => {
		const total = totalOf([
			{ path: ["s"], position: 1, persona: "a", reply: phase(1000, 1, 100, 50), record: phase(10, 0, 0, 0), tick: phase(500, 1, 300, 20) },
			{ path: ["s"], position: 2, persona: "b", reply: phase(2000, 1, 200, 70), record: phase(900, 1, 40, 8), tick: phase(700, 1, 350, 30, 1) },
		]);
		expect(total.reply).toEqual(phase(3000, 2, 300, 120));
		expect(total.record).toEqual(phase(910, 1, 40, 8));
		expect(total.tick).toEqual(phase(1200, 2, 650, 50, 1));
	});

	it("does not count a phase that never ran", () => {
		const total = totalOf([{ path: ["s"], position: 1, persona: "a", reply: phase(1500, 1, 90, 0, 1), record: null, tick: null }]);
		expect(total.tick).toEqual(phase(0, 0, 0, 0));
		expect(total.reply.unreported).toBe(1);
	});
});
