/**
 * The living loop tells its caller when there is no model, instead of abstaining in silence.
 *
 * A failed appraisal used to become "no evolution this turn" whatever the cause. For a network blip
 * that is still right: the persona replied, and the next turn tries again. "No model configured" is
 * not a blip, and since 2026-10-07 there is no offline appraiser to fall back on, so swallowing it
 * would leave a persona that never evolves and a caller that never hears why.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LivingLoop, ModelRequiredError } from "../src/index.js";

const FIX = `---
metadata: { name: t, version: 1.0.0 }
identity: { canonical_id: t }
improvement_policy: { mode: suggesting }
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-0.4, 0.4] }
---
body
`;

let dir: string;
let personaPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-loop-model-"));
	personaPath = join(dir, "personaxis.md");
	writeFileSync(personaPath, FIX);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("an appraisal that cannot happen", () => {
	it("rejects the tick when no model is configured", async () => {
		const appraiser = { appraise: async () => Promise.reject(new ModelRequiredError("Appraising what this persona lived")) };
		const loop = new LivingLoop(personaPath, { appraiser });
		await expect(loop.tick({ observation: "hello", source: "user" })).rejects.toBeInstanceOf(ModelRequiredError);
	});

	it("still abstains for this turn when the model is configured but unreachable", async () => {
		const appraiser = { appraise: async () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:9")) };
		const loop = new LivingLoop(personaPath, { appraiser });
		const report = await loop.tick({ observation: "hello", source: "user" });
		expect(report.abstained).toBe(true);
	});
});
