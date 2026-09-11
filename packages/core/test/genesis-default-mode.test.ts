/**
 * A persona Genesis creates must be able to evolve, and must not rewrite its own prose unasked.
 *
 * Until 2026-09-11 the default was `locked`, and in `locked` governance rejects every proposal
 * the model makes: the living loop observed and never applied anything, and nothing said so.
 * The default is now `suggesting`, which for numeric envelope mutations behaves exactly like
 * `autonomous` and for durable prose edits queues them for a person. This suite pins both
 * halves, because each one is the kind of default that drifts back without anybody noticing.
 */

import { describe, expect, it } from "vitest";

import { buildSpecObject } from "../src/genesis/spec-builder.js";
import { governQualitative } from "../src/governance.js";

const mode = () =>
	(buildSpecObject({ displayName: "Tester", purpose: "test" } as never).improvement_policy as { mode: string }).mode;

describe("the mode a freshly created persona is born with", () => {
	it("is suggesting, not locked", () => {
		expect(mode()).toBe("suggesting");
	});

	it("lets the numeric state move, because that is what the product sells", () => {
		// In locked this is exactly what used to be refused on every tick.
		expect(mode()).not.toBe("locked");
	});

	it("still queues durable edits to the persona's prose for a person", () => {
		expect(governQualitative(mode() as never)).toBe("queue");
	});

	it("respects an explicit choice made in the seed", () => {
		const locked = buildSpecObject({ displayName: "T", purpose: "t", improvementMode: "locked" } as never);
		expect((locked.improvement_policy as { mode: string }).mode).toBe("locked");
	});
});
