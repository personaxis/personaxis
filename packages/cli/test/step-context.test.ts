/**
 * Where an agent is in a service, said twice from one fact.
 *
 * It used to reach the agent as prose and only as prose: whoever built the prompt
 * wrote a sentence, and that sentence was everything. An agent could not ask which
 * step it was on, how many were left, or whether a person would read what it
 * produced before the next one started.
 *
 * Most of what is asserted here is about the sentence, because the sentence is what
 * every agent that exists today actually reads. The metadata is what an agent built
 * against us reads, and the point of both tests together is that they say the same
 * thing: a sentence and a field written separately can disagree, and when they do
 * the agent believes the sentence.
 */

import { describe, expect, it } from "vitest";

import { describeStep, metaFor } from "../src/workspace/step-context.js";

const middle = { service: "Weekly brief", step: 2, of: 4 };

describe("the sentence an agent reads", () => {
	it("says which step of what", () => {
		expect(describeStep(middle)).toContain("step 2 of 4");
		expect(describeStep(middle)).toContain("Weekly brief");
	});

	it("names the step when it has a name, and does not invent one when it has none", () => {
		expect(describeStep({ ...middle, name: "Draft it" })).toContain('"Draft it"');
		expect(describeStep(middle)).not.toContain('""');
	});

	it("tells a middle from an end, because they ask for different work", () => {
		// A template that said only "you are running a step" would flatten the two,
		// and the difference is what a step does with its output.
		const first = describeStep({ service: "S", step: 1, of: 3 });
		const last = describeStep({ service: "S", step: 3, of: 3 });

		expect(first).toContain("2 steps follow");
		expect(first).not.toContain("already run");
		expect(last).toContain("last step");
		expect(last).toContain("Steps 1 to 2 have already run");
	});

	it("counts in the singular when there is one of it", () => {
		const nearly = describeStep({ service: "S", step: 2, of: 3 });
		expect(nearly).toContain("1 step follows yours");
		expect(nearly).not.toContain("1 steps");
	});

	it("says when a person will read the work before anything else runs", () => {
		// An agent that knows this writes a different handover than one producing an
		// intermediate nobody will see.
		expect(describeStep({ ...middle, approvalBefore: true })).toContain("approve your work");
		expect(describeStep(middle)).not.toContain("approve");
	});

	it("says nothing at all for a run that belongs to no service", () => {
		// Most runs: somebody pressing Run on a persona. A paragraph explaining that
		// there is nothing to explain is worse than silence.
		expect(describeStep(undefined)).toBe("");
	});
});

describe("the same facts as metadata", () => {
	it("carries every field the sentence is built from", () => {
		const meta = metaFor({ ...middle, name: "Draft it", approvalBefore: true });
		expect(meta?.["personaxis.step"]).toEqual({
			service: "Weekly brief",
			step: 2,
			of: 4,
			name: "Draft it",
			approvalBefore: true,
		});
	});

	it("is namespaced, because `_meta` is a shared bag", () => {
		// The schema says implementations must make no assumptions about keys there,
		// so a bare `step` would be us assuming exactly that about everybody else.
		expect(Object.keys(metaFor(middle) ?? {})).toEqual(["personaxis.step"]);
	});

	it("omits what was not said, rather than sending nulls", () => {
		const meta = metaFor(middle)?.["personaxis.step"] as Record<string, unknown>;
		expect(Object.keys(meta).sort()).toEqual(["of", "service", "step"]);
	});

	it("is absent for a run with no step, so nothing sends an empty bag", () => {
		// `_meta: {}` says a thing was considered and found empty. Absent says it
		// never applied, which is the true one.
		expect(metaFor(undefined)).toBeUndefined();
	});
});

describe("the two renderings agree", () => {
	it("every number in the metadata appears in the sentence", () => {
		// The whole reason both come from one object. Written separately they can
		// disagree, and when they do the agent believes the sentence, so the field
		// becomes a thing that is true and has no effect.
		const step = { service: "Weekly brief", step: 2, of: 4, name: "Draft it" };
		const sentence = describeStep(step);
		const meta = metaFor(step)?.["personaxis.step"] as Record<string, unknown>;

		expect(sentence).toContain(String(meta["step"]));
		expect(sentence).toContain(String(meta["of"]));
		expect(sentence).toContain(String(meta["service"]));
		expect(sentence).toContain(String(meta["name"]));
	});

	it("agree about approval too, in both directions", () => {
		const asked = { ...middle, approvalBefore: true };
		expect(describeStep(asked).includes("approve")).toBe(
			(metaFor(asked)?.["personaxis.step"] as { approvalBefore?: boolean }).approvalBefore === true,
		);
		expect(describeStep(middle).includes("approve")).toBe(
			(metaFor(middle)?.["personaxis.step"] as { approvalBefore?: boolean }).approvalBefore === true,
		);
	});
});
