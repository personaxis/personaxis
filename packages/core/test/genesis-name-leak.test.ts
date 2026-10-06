/**
 * The extractor must not hand back its own instructions as the persona's name.
 *
 * Measured 2026-09-11: Qwen3-4B-Instruct named a code reviewer "Personaxis Genesis Seed:
 * Payments Service PR Reviewer". The compiled document would have opened "You are Personaxis
 * Genesis Seed...". The extraction prompt opens "You are the Personaxis Genesis extractor ...
 * extract a structured persona seed", and a small model followed the framing it was handed.
 */

import { describe, expect, it } from "vitest";

import { LEAKED_FRAMING, seedFromExtraction } from "../src/genesis/seed-extract.js";

describe("the extractor's framing does not become a name", () => {
	it("drops the name the model actually produced", () => {
		const { seed } = seedFromExtraction(
			{ displayName: "Personaxis Genesis Seed: Payments Service PR Reviewer", role: "PR reviewer", purpose: "Review changes" },
			"prompt",
		);
		expect(seed.displayName).toBeUndefined();
		// The role survives, so the builder has something honest to fall back to.
		expect(seed.role).toBe("PR reviewer");
	});

	for (const leak of ["Personaxis Assistant", "Genesis Seed", "genesis-seed", "The Extractor"]) {
		it(`treats "${leak}" as a leak`, () => expect(LEAKED_FRAMING.test(leak)).toBe(true));
	}

	it("keeps a real name that merely contains one of the words", () => {
		// Narrow on purpose: dropping a legitimate name is a cost too.
		for (const real of ["Genesis", "Seed Keeper", "Verity", "Marlow", "Revenue Analyst"]) {
			expect(LEAKED_FRAMING.test(real), real).toBe(false);
		}
	});

	it("keeps an ordinary extracted name untouched", () => {
		const { seed } = seedFromExtraction({ displayName: "Verity", role: "Data Analyst", purpose: "Revenue reporting" }, "prompt");
		expect(seed.displayName).toBe("Verity");
	});
});
