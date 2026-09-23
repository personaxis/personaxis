/**
 * E128: the affect bands Genesis writes are a way of working and a shade of tone, never a feeling.
 *
 * David decided on 2026-09-23 that a persona's evolution is to calibrate how it works and to say so
 * (plan, section 13.8), with bands that mix behaviour and tone. The line it replaced, "a negative
 * undertone colors your read of things", described a mood nobody could sell or measure. What has to
 * hold, and is checked here, is structural: three distinct lines per coordinate, because that is
 * what keeps value, band and behaviour connected (the compile Jacobian reads a coordinate whose lines
 * are all the same as decorative); a behaviour part and a tone part in every line; and no line that
 * describes a feeling, which universal U3 forbids.
 */
import { describe, expect, it } from "vitest";

import { synthesizeAffectExpression } from "../src/genesis/expression-synth.js";

const COORDINATES = ["core_affect.valence", "core_affect.arousal", "core_affect.dominance", "mood.tone", "mood.stability", "mood.recovery_rate"];
const FEELINGS = /\b(feel|feels|feeling|sad|happy|angry|anxious|undertone|upset|joy|gloom|mood)\b/i;

describe("the affect bands a new persona is born with (E128)", () => {
	for (const coordinate of COORDINATES) {
		const bands = synthesizeAffectExpression(coordinate);
		const lines = [bands.low, bands.moderate, bands.high];

		it(`${coordinate}: three distinct lines, so the band still moves behaviour`, () => {
			expect(new Set(lines).size).toBe(3);
		});

		it(`${coordinate}: every line is a way of working, then a shade of tone`, () => {
			for (const line of lines) {
				const [work, tone] = line.split(";");
				expect(work?.trim().startsWith("You") || work?.trim().startsWith("After")).toBe(true);
				expect(tone?.trim().length ?? 0).toBeGreaterThan(0);
			}
		});

		it(`${coordinate}: no line describes a feeling`, () => {
			for (const line of lines) expect(line).not.toMatch(FEELINGS);
		});
	}

	it("points the way the research does: lower valence checks more, lower dominance asks first", () => {
		expect(synthesizeAffectExpression("core_affect.valence").low).toMatch(/check/i);
		expect(synthesizeAffectExpression("core_affect.dominance").low).toMatch(/ask/i);
		expect(synthesizeAffectExpression("core_affect.arousal").low).toMatch(/one step at a time/i);
	});
});
