/**
 * What a destination can be asked to do, and the one silent bug worth copying a fix for.
 */

import { describe, expect, it } from "vitest";

import {
	EFFORT_LADDER,
	forDestination,
	mayReplay,
	resolveEffort,
	type DestinationCapabilities,
} from "../src/run/index.js";

const full: DestinationCapabilities = {
	id: "ours",
	effort: [...EFFORT_LADDER],
	foreignReasoning: true,
	cacheSeconds: 3600,
	rejects: [],
};

const modest: DestinationCapabilities = {
	id: "modest",
	effort: ["low", "medium"],
	foreignReasoning: false,
	cacheSeconds: 300,
	rejects: ["pattern", "format"],
};

describe("asking for more never resolves to more than was asked", () => {
	it("keeps a level the destination accepts", () => {
		expect(resolveEffort("high", full)).toEqual({ effort: "high" });
	});

	it("steps down to the nearest supported level, never up", () => {
		// Their silent bug: an unknown level fell back to a weak default, so asking for
		// the maximum resolved weaker than asking for a middle one. A ladder inversion,
		// and one that costs money in the direction nobody checks.
		expect(resolveEffort("max", modest)).toEqual({ effort: "medium", downgradedFrom: "max" });
		expect(resolveEffort("minimal", modest)).toEqual({ effort: "low", downgradedFrom: "minimal" });
	});

	it("never resolves above what was asked for, for any pair", () => {
		for (const asked of EFFORT_LADDER) {
			const resolved = resolveEffort(asked, modest);
			if (!resolved.effort) continue;
			const askedAt = EFFORT_LADDER.indexOf(asked);
			const gotAt = EFFORT_LADDER.indexOf(resolved.effort);
			// The one exception is a ladder with nothing below, where the weakest
			// supported level is taken and reported as a downgrade.
			if (gotAt > askedAt) expect(resolved.downgradedFrom).toBe(asked);
		}
	});

	it("reports the downgrade, because one nobody can see is one somebody argues about", () => {
		expect(resolveEffort("max", modest).downgradedFrom).toBe("max");
	});

	it("says nothing at all when the destination takes no effort levels", () => {
		expect(resolveEffort("high", { ...modest, effort: [] })).toEqual({ effort: undefined });
	});
});

describe("sealed reasoning is only replayed where it was sealed", () => {
	it("lets a destination replay its own", () => {
		expect(mayReplay("modest", modest)).toBe(true);
	});

	it("refuses somebody else's unless the destination says it accepts it", () => {
		// Replaying a sealed blob elsewhere fails deterministically, so a wrong answer
		// here is a rejected request rather than a degraded one.
		expect(mayReplay("elsewhere", modest)).toBe(false);
		expect(mayReplay("elsewhere", full)).toBe(true);
	});
});

describe("anything destination-specific happens on a copy", () => {
	it("does not touch the request it was given", () => {
		// Their bug generalises: a sanitiser that mutated in place held a reference to
		// the shared tool registry, so one strict provider left it permanently trimmed
		// for every later call to every other provider.
		const original = {
			destination: "unset",
			effort: "max" as const,
			messages: [{ role: "user", text: "hola" }],
			tools: ["shell", "read"],
		};

		const adapted = forDestination(original, modest);
		adapted.tools.length;
		(adapted.messages as { text: string }[])[0]!.text = "changed";

		expect(original.messages[0]!.text).toBe("hola");
		expect(original.effort).toBe("max");
		expect(adapted.effort).toBe("medium");
	});

	it("gives each destination its own tool list rather than a shared one", () => {
		const original = { destination: "unset", messages: [], tools: ["shell"] };

		const a = forDestination(original, modest);
		const b = forDestination(original, full);
		(a.tools as string[]).push("extra");

		expect(b.tools).toEqual(["shell"]);
		expect(original.tools).toEqual(["shell"]);
	});
});
