/**
 * A persona whose living loop is switched off has to say so.
 *
 * Measured 2026-09-11: every persona `personaxis create` makes is `improvement_policy: locked`,
 * and in `locked` `governance.ts` rejects every proposal the model makes. The living loop
 * therefore observes, appraises and proposes, and never applies anything. `state drift` said
 * nothing about it, which is how a day of experiments measured a persona whose defining feature
 * was off while believing it was on.
 */

import { describe, expect, it } from "vitest";

import { describeMode } from "../src/commands/state.js";

describe("the drift report names the improvement mode", () => {
	it("says plainly that a locked persona does not evolve", () => {
		const line = describeMode("locked");
		expect(line).toMatch(/does NOT evolve/);
		expect(line).toMatch(/rejected/);
		// And it says how to change that, because a warning without a way out is just noise.
		expect(line).toMatch(/suggesting or autonomous/);
	});

	it("says a suggesting persona queues rather than applies", () => {
		expect(describeMode("suggesting")).toMatch(/queued/);
		expect(describeMode("suggesting")).not.toMatch(/does NOT evolve/);
	});

	it("says an autonomous persona applies, and still inside its bounds", () => {
		const line = describeMode("autonomous");
		expect(line).toMatch(/apply/);
		// Autonomous is not unbounded, and the line must not let anyone read it that way.
		expect(line).toMatch(/envelopes/);
	});

	it("does not invent a meaning for a mode it does not know", () => {
		expect(describeMode("something-new")).toBe("improvement_policy = something-new");
	});

	describe("the control of the control", () => {
		it("the locked warning is distinguishable from every other mode", () => {
			// If this passed for autonomous too, the warning would say nothing.
			for (const other of ["suggesting", "autonomous"]) {
				expect(describeMode(other)).not.toMatch(/does NOT evolve/);
			}
		});
	});
});
