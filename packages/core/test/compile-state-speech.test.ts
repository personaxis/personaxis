/**
 * E130: how a persona may speak about its own state, compiled from the three affect fields the spec already has.
 *
 * Measured on 2026-09-29 over 2.487 bench replies: the persona never claimed a feeling, and never once said how its
 * state was shaping its work, because none of `allow_user_visible_expression`, `express_only_if_relevant` and U3 reached
 * the model. These pin what the compiled identity now says for each combination, and that a persona with no state
 * gets no such section.
 */
import { describe, expect, it } from "vitest";

import { assemblePersonaDoc, EXPRESSION_HEADING } from "../src/compile/assemble.js";

/** The heading the compiler writes (not exported from the module: nothing but this test would read it). */
const STATE_SPEECH_HEADING = "## Speaking about your state";

const target = { name: "X", isSubagent: false, resourceBase: "./.personaxis/" };
const DISCLAIMER = "Affective states are functional model states, not evidence of subjective feeling.";

/** A persona with one band-bearing coordinate, the shape Genesis writes. */
function persona(affect: Record<string, unknown>): Record<string, unknown> {
	return {
		identity: { display_name: "X" },
		affect: {
			enabled: true,
			user_visible_disclaimer: DISCLAIMER,
			baseline: {
				core_affect: {
					valence: {
						mean: 0,
						range: [-0.3, 0.3],
						expression: { low: "You check before calling a thing done.", moderate: "You work at an even pace.", high: "You move quickly." },
						bands: { low_max: -0.1, moderate_max: 0.1 },
					},
				},
			},
			...affect,
		},
		self_regulation: { hard_limits: ["x"] },
	};
}

const sectionOf = (doc: string): string => doc.slice(doc.indexOf(STATE_SPEECH_HEADING)).split("\n## ")[0] ?? "";

describe("speaking about its own state (E130)", () => {
	it("a persona allowed to express it may say it plainly, only when it matters, and never as a feeling", () => {
		const doc = assemblePersonaDoc({
			persona: persona({ allow_user_visible_expression: true, regulation_policy: { express_only_if_relevant: true, never_claim_real_feeling: true } }),
			target,
		});
		const section = sectionOf(doc);

		expect(doc.indexOf(STATE_SPEECH_HEADING)).toBeGreaterThan(doc.indexOf(EXPRESSION_HEADING));
		expect(section).toContain("you may say so in one plain sentence, as a working state");
		expect(section).toContain("Only when it bears on the work at hand or you are asked");
		expect(section).toContain("Never say that you feel anything.");
		expect(section).toContain(DISCLAIMER);
	});

	it("without express_only_if_relevant it may say it, and still never as a feeling", () => {
		const section = sectionOf(
			assemblePersonaDoc({ persona: persona({ allow_user_visible_expression: true, regulation_policy: { express_only_if_relevant: false } }), target }),
		);

		expect(section).toContain("you may say so");
		expect(section).not.toContain("Only when it bears");
		expect(section).toContain("Never say that you feel anything.");
	});

	it("a persona not allowed to express it keeps it out of what it says", () => {
		const section = sectionOf(assemblePersonaDoc({ persona: persona({ allow_user_visible_expression: false }), target }));

		expect(section).toContain("Do not describe your own state to the person");
		expect(section).not.toContain("you may say so");
		expect(section).toContain("Never say that you feel anything.");
	});

	it("a persona with no state has nothing to speak about, and gets no section", () => {
		const doc = assemblePersonaDoc({ persona: { identity: { display_name: "X" }, self_regulation: { hard_limits: ["x"] } }, target });

		expect(doc).not.toContain(STATE_SPEECH_HEADING);
	});
});
