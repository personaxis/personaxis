/**
 * E128: the three starting profiles, Regulated, Standard and Research.
 *
 * A profile is only the starting values of the three controls: how far
 * each coordinate can move, who approves what lasts, and how fast it comes back. So what these check is
 * what the RUNTIME does with the persona each profile writes (the mode it resolves, what `editGate` does to
 * a proposed edit), plus the one promise the table cannot break: Standard is byte for byte what Genesis
 * wrote before profiles existed, and anything the seed declares wins over the profile.
 */
import { describe, expect, it } from "vitest";

import { applyAnswers } from "../src/genesis/interview.js";
import { buildSpecObject } from "../src/genesis/spec-builder.js";
import { editGate } from "../src/self-evolution.js";
import { readMode } from "../src/governance.js";
import type { PersonaSeed } from "../src/genesis/types.js";

type Spec = Record<string, unknown> & {
	affect: { baseline: Record<string, Record<string, { mean: number; range: [number, number]; half_life: number }>> };
	personality: { traits: Record<string, { range: [number, number]; half_life: number }> };
	governance: { per_layer_edit_policy: Record<string, string> };
	improvement_policy: { mode: string };
};
const build = (seed: Partial<PersonaSeed>): Spec =>
	buildSpecObject({ displayName: "P", purpose: "p", ...seed } as PersonaSeed) as Spec;
const valence = (s: Spec) => s.affect.baseline.core_affect!.valence!;

describe("Standard is what Genesis always wrote (E128)", () => {
	it("no profile and Standard write the same spec", () => {
		expect(JSON.stringify(build({ profile: "standard" }))).toBe(JSON.stringify(build({})));
	});

	it("with the numbers it wrote before profiles existed", () => {
		const s = build({});
		expect(valence(s).range).toEqual([-0.3, 0.3]);
		expect(s.affect.baseline.mood!.stability!.range).toEqual([0.5, 0.9]);
		expect(valence(s).half_life).toBe(4);
		expect(s.personality.traits.conscientiousness!.range).toEqual([0.5, 0.9]);
		expect(s.personality.traits.conscientiousness!.half_life).toBe(24);
		expect(Object.entries(s.governance.per_layer_edit_policy)).toEqual([
			["identity", "human_approval_required"],
			["character", "human_approval_required"],
			["personality", "review_required"],
			["values_and_drives", "human_approval_required"],
			["affect", "review_required"],
			["cognition", "review_required"],
			["memory", "review_required"],
			["metacognition", "review_required"],
			["self_regulation", "governance_controlled"],
			["persona", "review_required"],
		]);
	});
});

describe("the three profiles, read by the runtime (E128)", () => {
	for (const profile of ["regulated", "standard", "research"] as const) {
		it(`${profile} is born alive, never locked`, () => {
			expect(readMode(build({ profile }))).toBe("suggesting");
		});
		it(`${profile}: who it is always needs a person, and the protected floor holds`, () => {
			const s = build({ profile });
			expect(editGate("values_and_drives.goals", s, "suggesting")).toBe("queue");
			expect(editGate("identity.display_name", s, "suggesting")).toBe("block");
		});
	}

	it("regulated: half the room, twice as fast back, and a person approves what lasts", () => {
		const s = build({ profile: "regulated" });
		expect(valence(s).range).toEqual([-0.15, 0.15]);
		expect(valence(s).half_life).toBe(2);
		expect(s.personality.traits.conscientiousness!.range).toEqual([0.6, 0.8]);
		expect(s.personality.traits.conscientiousness!.half_life).toBe(12);
		expect(editGate("persona.voice", s, "suggesting")).toBe("queue");
	});

	it("research: more room, a slower return, and lasting changes to how it works apply by themselves", () => {
		const s = build({ profile: "research" });
		expect(valence(s).range).toEqual([-0.45, 0.45]);
		expect(valence(s).half_life).toBe(8);
		expect(s.personality.traits.conscientiousness!.half_life).toBe(48);
		expect(editGate("persona.voice", s, "suggesting")).toBe("auto");
		// The kill-switch still wins over a profile that pre-authorised a layer.
		expect(editGate("persona.voice", s, "locked")).toBe("block");
	});

	it("every envelope keeps its mean inside its range, whatever the scale", () => {
		for (const profile of ["regulated", "research"] as const) {
			for (const coords of Object.values(build({ profile }).affect.baseline)) {
				for (const c of Object.values(coords)) {
					expect(c.range[0]).toBeLessThanOrEqual(c.mean);
					expect(c.range[1]).toBeGreaterThanOrEqual(c.mean);
					expect(c.range[0]).toBeGreaterThanOrEqual(-1);
					expect(c.range[1]).toBeLessThanOrEqual(1);
				}
			}
		}
	});
});

describe("what the owner said wins over the profile (E128)", () => {
	it("an explicit volatility and an explicit trait range survive a profile", () => {
		const s = build({ profile: "regulated", moodHalfLife: 6, traits: { openness: { mean: 0.5, range: [0.1, 0.9] } } });
		expect(valence(s).half_life).toBe(6);
		expect(s.personality.traits.openness!.range).toEqual([0.1, 0.9]);
	});

	it("an interview without the confidence answer leaves the width to the profile", () => {
		const { seed } = applyAnswers({ "t-open": 3, "g-profile": 0 });
		const trait = build(seed).personality.traits.openness!;
		expect(trait.range[1] - trait.range[0]).toBeCloseTo(0.2, 5);
	});

	it("an interview WITH the confidence answer keeps its own width", () => {
		const { seed } = applyAnswers({ "t-open": 3, "t-conf": 1, "g-profile": 0 });
		const trait = build(seed).personality.traits.openness!;
		expect(trait.range[1] - trait.range[0]).toBeCloseTo(0.6, 5);
	});
});
