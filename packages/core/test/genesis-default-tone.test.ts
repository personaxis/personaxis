/**
 * The tone a persona gets when its brief names none has to read as English once compiled.
 *
 * The default was `professional_direct`, and the compiler turns underscores into spaces, so every
 * persona created without a tone told its model "Your tone is professional direct." Seen on
 * 2026-10-03 in the review before the first release, in the repository's own Gamewright.
 */
import { describe, expect, it } from "vitest";

import { assemblePersonaDoc } from "../src/compile/assemble.js";
import { buildSpecObject } from "../src/genesis/spec-builder.js";

const compiledTone = (seed: Record<string, unknown>): string | undefined => {
	const doc = assemblePersonaDoc({ persona: buildSpecObject(seed as never), target: { name: "Tester", isSubagent: false, resourceBase: "./.personaxis/" } });
	return /Your tone is ([^.]+)\./.exec(doc)?.[1];
};

describe("the default tone, compiled", () => {
	it("reads as a phrase when the brief names no tone", () => {
		expect(compiledTone({ displayName: "Tester", purpose: "test" })).toBe("professional and direct");
	});

	it("keeps a tone the brief did name", () => {
		expect(compiledTone({ displayName: "Tester", purpose: "test", tone: "warm and curious" })).toBe("warm and curious");
	});
});
