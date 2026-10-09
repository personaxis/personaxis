/**
 * E127: a persona returns to its baseline by itself.
 *
 * Until 2026-09-23 only the mood's tone had a half-life, so whatever a failure moved in valence, dominance
 * or a personality trait stayed there, which is the shape learned helplessness would take. Genesis gave
 * every coordinate a default half-life; since 2026-10-07 the authoring model sets each one and `checkStage`
 * refuses an envelope in personality or affect that declares none. What stays here is the runtime half:
 * a coordinate with a half-life comes back with nothing else happening.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureState, extractEnvelopes, LivingLoop, loadPersona, record } from "../src/index.js";

const PERSONA = `---
apiVersion: personaxis.com/v1
kind: AgentPersona
spec_version: "1.1.0"
metadata: { name: tester, version: 1.0.0, description: test, created: "2026-10-07" }
identity: { canonical_id: tester, display_name: Tester, system_identity: { purpose: test }, role_identity: { primary_role: tester, relationship_to_user: tester } }
improvement_policy: { mode: suggesting }
affect:
  baseline:
    core_affect:
      valence: { mean: 0.0, range: [-0.3, 0.3], half_life: 4 }
---
body
`;

describe("a persona comes back from a bad run by itself (E127)", () => {
	let dir = "";
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("halves how far a failure moved it within the half-life, with nothing else happening", async () => {
		dir = mkdtempSync(join(tmpdir(), "pxs-e127-"));
		const personaPath = join(dir, "personaxis.md");
		writeFileSync(personaPath, PERSONA);
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

		// Four quiet turns, its half-life: the appraiser proposes nothing, so only homeostasis moves it.
		const quiet = { appraise: async () => ({ appraisal: "", mutations: [], memories: [], confidence: 1 }) };
		const loop = new LivingLoop(personaPath, { appraiser: quiet });
		for (let i = 0; i < 4; i += 1) await loop.tick({ observation: "Noted.", source: "user" });

		const after = ensureState(loadPersona(personaPath)).values["affect.baseline.core_affect.valence"]!;
		expect(Math.abs(after)).toBeLessThanOrEqual(Math.abs(moved) / 2 + 1e-9);
		expect(after).toBeLessThan(0);
	});
});
