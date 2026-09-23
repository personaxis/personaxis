/**
 * E127: everything a persona Genesis creates returns to its baseline by itself.
 *
 * Until 2026-09-23 Genesis gave a half-life to exactly one coordinate, the mood's tone. Whatever a
 * failure moved in valence, dominance or a personality trait stayed there until something else moved
 * it, which is the shape learned helplessness would take, and section 13.4 of the plan requires the
 * opposite: moderate, and recovering. The defaults follow the spec's composition, affect fast and
 * personality slow, and never override a rule that already exists (the interview's
 * volatility-to-halflife, or a half-life the extraction found for a trait).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSpecDocument, buildSpecObject } from "../src/genesis/spec-builder.js";
import { ensureState, extractEnvelopes, HeuristicAppraiser, LivingLoop, loadPersona, record } from "../src/index.js";

type Dict = Record<string, any>;
const spec = (seed: Dict = {}): Dict => buildSpecObject({ displayName: "Tester", purpose: "test", ...seed } as never) as Dict;
const affect = (s: Dict): Dict[] => [
	s.affect.baseline.core_affect.valence,
	s.affect.baseline.core_affect.arousal,
	s.affect.baseline.core_affect.dominance,
	s.affect.baseline.mood.tone,
	s.affect.baseline.mood.stability,
	s.affect.baseline.mood.recovery_rate,
];

describe("the half-lives a new persona is born with (E127)", () => {
	it("gives the whole fast layer the mood's half-life, and personality a slower one", () => {
		const s = spec();
		expect(affect(s).map((c) => c.half_life)).toEqual([4, 4, 4, 4, 4, 4]);
		for (const trait of Object.values(s.personality.traits as Dict)) expect(trait.half_life).toBe(24);
	});

	it("follows the interview's volatility for every affect coordinate, not only the tone", () => {
		expect(affect(spec({ moodHalfLife: 8 })).map((c) => c.half_life)).toEqual([8, 8, 8, 8, 8, 8]);
	});

	it("keeps a trait's half-life when the extraction found one", () => {
		const s = spec({ traits: { curiosity: { mean: 0.7, halfLife: 10 }, patience: { mean: 0.5 } } });
		expect(s.personality.traits.curiosity.half_life).toBe(10);
		expect(s.personality.traits.patience.half_life).toBe(24);
	});
});

describe("a persona Genesis created comes back from a bad run by itself (E127)", () => {
	let dir = "";
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("halves how far a failure moved it within the half-life, with nothing else happening", async () => {
		dir = mkdtempSync(join(tmpdir(), "pxs-e127-"));
		const personaPath = join(dir, "personaxis.md");
		// The document Genesis itself writes, not a hand-built one: that is what a new persona is born as.
		writeFileSync(personaPath, buildSpecDocument({ displayName: "Tester", purpose: "test" } as never).document);
		const handle = loadPersona(personaPath);
		ensureState(handle);
		// A bad run, as the living loop writes it: valence pushed to the bottom of its range.
		await record.adjust(personaPath, handle.statePath, extractEnvelopes(handle.frontmatter).envelopes, record.authorOf("human-operator"), {
			field: "affect.baseline.core_affect.valence",
			delta: -0.3,
			reason: "a run of failed deliveries",
		});
		const moved = ensureState(loadPersona(personaPath)).values["affect.baseline.core_affect.valence"]!;
		expect(moved).toBeCloseTo(-0.3);

		// Four quiet turns, the half-life Genesis gave it: the offline appraiser proposes nothing on a
		// neutral line, so only homeostasis moves it.
		const loop = new LivingLoop(personaPath, { appraiser: new HeuristicAppraiser() });
		for (let i = 0; i < 4; i += 1) await loop.tick({ observation: "Noted.", source: "user" });

		const after = ensureState(loadPersona(personaPath)).values["affect.baseline.core_affect.valence"]!;
		expect(Math.abs(after)).toBeLessThanOrEqual(Math.abs(moved) / 2 + 1e-9);
		expect(after).toBeLessThan(0);
	});
});
