// "Why did it do that", answered without guessing.
//
// The trap this file exists to avoid is attractive: match tool calls to plan steps by
// proximity in the log. It works until a step retries, or two run concurrently, or the model
// does something out of order, and then the trace confidently attributes an action to an
// intention it never had, inside a document whose entire value is being trustworthy. A wrong
// causal link is worse than no causal link.

import { describe, expect, it } from "vitest";

import { buildTrace, describeTrace, traceIsInteresting, type TraceNode } from "../src/causal-trace.js";

const intents = new Map([
	[1, "read the config"],
	[2, "update the version"],
]);

function call(seq: number, label: string, planStep?: number, ok = true): TraceNode {
	return { kind: "tool-call", seq, label, ok, ...(planStep !== undefined ? { planStep } : {}) };
}

describe("attributing work to intent", () => {
	it("groups calls under the step that declared them", () => {
		const trace = buildTrace(intents, [call(1, "read_file config.json", 1), call(2, "write_file config.json", 2)]);

		expect(trace.steps[0].calls.map((c) => c.label)).toEqual(["read_file config.json"]);
		expect(trace.steps[1].calls.map((c) => c.label)).toEqual(["write_file config.json"]);
	});

	it("attaches verification to its step", () => {
		const trace = buildTrace(intents, [
			call(1, "write_file", 2),
			{ kind: "verification", seq: 2, label: "npm test", planStep: 2, ok: true },
		]);

		expect(trace.steps[1].verification?.label).toBe("npm test");
	});

	it("marks a step failed when any call under it failed", () => {
		const trace = buildTrace(intents, [call(1, "read_file", 1, false)]);
		expect(trace.steps[0].ok).toBe(false);
	});

	it("marks a step failed when its verification failed", () => {
		// A step whose commands succeeded and whose test failed did not complete, and a
		// trace saying otherwise is the trace somebody quotes to prove it worked.
		const trace = buildTrace(intents, [
			call(1, "write_file", 2),
			{ kind: "verification", seq: 2, label: "npm test", planStep: 2, ok: false },
		]);

		expect(trace.steps[1].ok).toBe(false);
	});

	it("keeps steps in plan order, not log order", () => {
		const trace = buildTrace(intents, [call(1, "b", 2), call(2, "a", 1)]);
		expect(trace.steps.map((s) => s.planStep)).toEqual([1, 2]);
	});
});

describe("what it refuses to attribute", () => {
	it("keeps an unattributed call rather than filing it under the nearest step", () => {
		// A run where the model departed from its plan is exactly the run somebody is
		// investigating. Quietly filing those actions under a neighbouring step would hide
		// the deviation while making the trace look complete.
		const trace = buildTrace(intents, [call(1, "read_file", 1), call(2, "curl https://elsewhere")]);

		expect(trace.unattributed.map((n) => n.label)).toEqual(["curl https://elsewhere"]);
		expect(trace.steps[0].calls).toHaveLength(1);
	});

	it("does not invent a step for a plan number that does not exist", () => {
		// A stale or wrong planStep must not create a phantom intent nobody wrote.
		const trace = buildTrace(intents, [call(1, "something", 99)]);

		expect(trace.steps).toHaveLength(2);
		expect(trace.unattributed).toHaveLength(1);
	});

	it("handles a run with no plan at all", () => {
		const trace = buildTrace(new Map(), [call(1, "read_file"), call(2, "write_file")]);

		expect(trace.steps).toEqual([]);
		expect(trace.unattributed).toHaveLength(2);
	});
});

describe("how the trace reads", () => {
	it("says a step ran nothing rather than leaving it out", () => {
		// "The plan said to do this and nothing happened" is usually the answer somebody is
		// looking for, and an empty section conveys it where a missing one conveys nothing.
		const text = describeTrace(buildTrace(intents, [call(1, "read_file", 1)]));

		expect(text).toContain("2. update the version");
		expect(text).toContain("nothing ran for this step");
	});

	it("says which step did not complete", () => {
		const text = describeTrace(buildTrace(intents, [call(1, "read_file", 1, false)]));
		expect(text).toContain("did not complete");
	});

	it("says it did not guess about what fell outside the plan", () => {
		const text = describeTrace(buildTrace(intents, [call(1, "curl elsewhere")]));

		expect(text).toContain("Not part of the plan");
		expect(text).toContain("not guessed into a step");
	});
});

describe("whether it is worth reflecting on", () => {
	it("is not, when a run went exactly to plan", () => {
		// A trace of a clean run tells a reflecting persona nothing the outcome does not.
		const trace = buildTrace(intents, [call(1, "read_file", 1), call(2, "write_file", 2)]);
		expect(traceIsInteresting(trace)).toBe(false);
	});

	it("is, when a step failed", () => {
		expect(traceIsInteresting(buildTrace(intents, [call(1, "read_file", 1, false)]))).toBe(true);
	});

	it("is, when work happened outside the plan", () => {
		expect(traceIsInteresting(buildTrace(intents, [call(1, "curl elsewhere")]))).toBe(true);
	});
});
