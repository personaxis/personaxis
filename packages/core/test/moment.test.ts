/**
 * E118: how the persona is right now, said only when it is no longer what the frozen identity says.
 *
 * The identity stays frozen for the session (the study's synthesis, section 1), so the state reaches
 * the working agent through the message of the moment. The risk that decides the design is measured:
 * telling an agent more than it needs can stop it using tools. So the strongest checks here are the
 * ones about SILENCE: nothing is said when nothing changed, and nothing is said when the identity
 * carries no expression section to compare against.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assemblePersonaDoc, loadPersona, PersonaAgent, writeState } from "../src/index.js";
import { howYouAreNow } from "../src/moment.js";

const PERSONA = {
	metadata: { name: "wright" },
	identity: { canonical_id: "wright" },
	affect: {
		baseline: {
			mood: {
				tone: {
					mean: 0.5,
					range: [0, 1],
					expression: { low: "You are flat and terse today.", moderate: "You are even and warm.", high: "You are buoyant and quick." },
				},
			},
		},
	},
};

const target = { name: "Wright", isSubagent: false, resourceBase: "./.personaxis/" };
/** The identity as the compiler writes it for a given state: what the agent was handed at the start. */
const frozenAt = (tone: number): string => assemblePersonaDoc({ persona: PERSONA, target, stateValues: { "mood.tone": tone } });

describe("how the persona is right now (E118)", () => {
	it("says nothing when the persona is as its identity says", () => {
		expect(howYouAreNow(frozenAt(0.5), PERSONA, { "mood.tone": 0.5 })).toBe("");
		// And moving inside the same band is not a change in how it expresses.
		expect(howYouAreNow(frozenAt(0.5), PERSONA, { "mood.tone": 0.55 })).toBe("");
	});

	it("says exactly the line that changed, in the compiler's own words, when a band was crossed", () => {
		const now = howYouAreNow(frozenAt(0.5), PERSONA, { "mood.tone": 0.05 });
		expect(now).toContain("# How you are right now");
		expect(now).toContain("You are flat and terse today.");
		expect(now).not.toContain("You are even and warm.");
	});

	it("says nothing about an identity that has no expression section to compare with", () => {
		expect(howYouAreNow("# You are Wright\n\nA raw spec body.", PERSONA, { "mood.tone": 0.05 })).toBe("");
	});

	it("says nothing when there is no state to read", () => {
		expect(howYouAreNow(frozenAt(0.5), PERSONA, undefined)).toBe("");
	});
});

describe("the working agent hears it in the moment, and its identity does not move (E118)", () => {
	const FIX = [
		"---",
		"metadata: { name: wright, version: 1.0.0 }",
		"identity: { canonical_id: wright }",
		"affect:",
		"  baseline:",
		"    mood:",
		"      tone:",
		"        mean: 0.5",
		"        range: [0, 1]",
		"        expression: { low: You are flat and terse today., moderate: You are even and warm., high: You are buoyant and quick. }",
		"---",
		"body",
		"",
	].join("\n");

	const agentAt = async (tone: number): Promise<{ prefix: string; moment: string }> => {
		const dir = mkdtempSync(join(tmpdir(), "pxs-moment-"));
		try {
			const personaPath = join(dir, "personaxis.md");
			writeFileSync(personaPath, FIX);
			const handle = loadPersona(personaPath);
			writeState(handle.statePath, { schema_version: "0.6.0", persona_id: "wright", persona_version: "1", values: { "mood.tone": tone }, mutation_log: [] });
			const agent = new PersonaAgent({ llm: stub(), personaPath, personaBody: frozenAt(0.5) });
			await agent.run("say done");
			const system = (agent.lastMessages ?? []).filter((m) => m.role === "system").map((m) => String(m.content ?? ""));
			return { prefix: system[0] ?? "", moment: system.find((s) => s.startsWith("# Right now")) ?? "" };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it("adds the change to the moment and leaves the frozen prefix byte for byte", async () => {
		const same = await agentAt(0.5);
		const crossed = await agentAt(0.05);
		expect(same.moment).not.toContain("How you are right now");
		expect(crossed.moment).toContain("You are flat and terse today.");
		// The cached, audited identity is the same bytes either way: the change travels beside it.
		expect(crossed.prefix).toBe(same.prefix);
	});
});

function stub() {
	const fetchImpl = (async () =>
		new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { total_tokens: 10, prompt_tokens: 5 } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
	return { endpoint: "http://stub", model: "stub-model", fetchImpl };
}
