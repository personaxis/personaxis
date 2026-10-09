/**
 * E128: the starting profile (regulated, standard, research) reaches the model that authors the persona,
 * and whatever it authors under any profile is a persona that validates.
 *
 * Until 2026-10-07 a profile was a table of defaults the builder wrote; since H15 it is guidance in every
 * stage's prompt, so what is pinned here is that the guidance arrives, differs per profile, and that the
 * recorded answers of a real run come out valid under each one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { authorPersona, GENESIS_PROFILES, numberSources, profileGuidance, STAGES, stagePrompt } from "@personaxis/core";
import { validatePersona } from "../src/schema.js";
import { runCreate } from "../src/commands/create.js";

const RECORDED = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "genesis-terse-reviewer.json"), "utf8")) as {
	brief: string;
	answers: Record<string, unknown>;
};
const sources = numberSources([{ kind: "brief", label: "the brief", text: RECORDED.brief }]);

describe("every Genesis profile reaches the author and yields a valid persona (E128)", () => {
	for (const profile of GENESIS_PROFILES) {
		it(`${profile}`, async () => {
			for (const stage of STAGES) expect(stagePrompt(stage, sources, {}, profile)).toContain(profileGuidance(profile));
			const { spec } = await authorPersona({ sources, profile, today: "2026-10-07", call: async (_p, _s, name) => RECORDED.answers[name.replace(/^persona_/, "")] });
			const result = validatePersona(spec as Record<string, unknown>);
			expect(result.status, JSON.stringify(result.errors.slice(0, 5), null, 2)).toMatch(/^PASS/);
		});
	}

	it("each profile says something different", () => {
		expect(new Set(GENESIS_PROFILES.map((p) => profileGuidance(p))).size).toBe(GENESIS_PROFILES.length);
	});

	it("create refuses an unknown profile before asking or writing anything", async () => {
		await expect(runCreate(undefined, { profile: "strict", intent: "x", yes: true })).rejects.toThrow(/--profile must be one of regulated, standard, research/);
	});
});
