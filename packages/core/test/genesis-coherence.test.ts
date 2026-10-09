/**
 * The coherence reading: after the eleven stages, one call lists every rule the sources state and where the
 * persona keeps it; a rule no field keeps goes back to the stage it belongs to, which must then carry it.
 *
 * Measured 2026-10-07 with command-a on a fifteen-answer interview: "Currency in floats is never acceptable"
 * reached no field until this reading sent it back to self_regulation, and the first time it was sent back
 * the stage answered without it, which is why the fix is checked in the answer and not taken on trust. The
 * stage answers here are a real run's (the CLI's recorded fixture); the reading is a stub.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { authorPersona, numberSources, renderCreationReport, type StructuredCaller } from "../src/index.js";

const FIXTURE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "test", "fixtures", "genesis-terse-reviewer.json"), "utf8")) as {
	brief: string;
	answers: Record<string, { layer: Record<string, unknown> } & Record<string, unknown>>;
};
const RULE = "Currency in floats is never acceptable.";
const sources = numberSources([{ kind: "brief", label: "the brief", text: `${FIXTURE.brief}. ${RULE}` }]);
const today = "2026-10-07";

/** A model that answers every stage from the recording, and the coherence reading with `reading`. */
function model(reading: unknown, rewrite: (attempt: number) => unknown): { call: StructuredCaller; prompts: string[] } {
	const prompts: string[] = [];
	let rewrites = 0;
	const call: StructuredCaller = async (prompt, _schema, name) => {
		prompts.push(prompt);
		if (name === "persona_coherence") return reading;
		if (name === "persona_self_regulation" && prompt.includes("A reading of the whole persona found")) return rewrite(++rewrites);
		return FIXTURE.answers[name.replace(/^persona_/, "")];
	};
	return { call, prompts };
}

const withRule = () => {
	const answer = structuredClone(FIXTURE.answers.self_regulation) as { layer: { self_regulation: { hard_limits: string[] } } } & Record<string, unknown>;
	answer.layer.self_regulation.hard_limits.push(RULE);
	return answer;
};
const missing = { reasoning: "The brief states one rule no field keeps.", rules: [{ source: "S1", quote: RULE, belongs_in: "self_regulation" }], contradictions: [] };

describe("the coherence reading", () => {
	it("sends a rule no field keeps to its stage, and keeps the answer that carries it", async () => {
		const { call, prompts } = model(missing, () => withRule());
		const authored = await authorPersona({ sources, call, today });
		expect((authored.spec.self_regulation as { hard_limits: string[] }).hard_limits).toContain(RULE);
		expect(authored.coherence?.findings.map((f) => f.stage)).toEqual(["self_regulation"]);
		expect(authored.coherence?.unresolved).toEqual([]);
		expect(prompts.some((p) => p.includes(`a rule a source states is kept by no field: "${RULE}"`))).toBe(true);
	});

	it("asks again when the stage answers without the fix, and reports it when the repairs run out", async () => {
		const { call, prompts } = model(missing, () => FIXTURE.answers.self_regulation);
		const authored = await authorPersona({ sources, call, today });
		expect(prompts.filter((p) => p.includes(`The rule "${RULE}" is still in no field of this part`))).toHaveLength(2);
		expect(authored.coherence?.unresolved).toEqual([`S1: "${RULE}"`]);
		const report = renderCreationReport(authored, sources, []);
		expect(report).toContain("## Coherence (1 rule(s) the sources state, 1 sent back)");
		expect(report).toContain(`- ⚠️ S1: "${RULE}"`);
	});

	it("checks the reading's evidence: the quote in its source, and a field that exists and says something of the rule", async () => {
		const bad = {
			reasoning: "r",
			rules: [
				{ source: "S1", quote: "Floats are fine for money.", belongs_in: "self_regulation" },
				{ source: "S1", quote: RULE, kept_in: "self_regulation.hard_limits.99" },
				{ source: "S1", quote: RULE, kept_in: "self_regulation.hard_limits.0" },
			],
			contradictions: [],
		};
		const { call, prompts } = model(bad, () => withRule());
		await authorPersona({ sources, call, today }).catch(() => undefined);
		const repair = prompts.find((p) => p.startsWith("You are checking a whole AI persona") && p.includes("It failed these checks")) ?? "";
		expect(repair).toContain("rules[0].quote is not in source S1");
		expect(repair).toContain("rules[1].kept_in names self_regulation.hard_limits.99, which the persona does not have");
		expect(repair).toMatch(/rules\[2\]\.kept_in names self_regulation\.hard_limits\.0, which says nothing of/);
	});

	it("accepts a rule kept in a list item, the way models name them", async () => {
		const kept = { reasoning: "r", rules: [{ source: "S1", quote: "A terse code reviewer that never softens findings", kept_in: "self_regulation.hard_limits.3" }], contradictions: [] };
		const { call, prompts } = model(kept, () => withRule());
		const authored = await authorPersona({ sources, call, today });
		expect(authored.coherence?.findings).toEqual([]);
		expect(prompts.filter((p) => p.startsWith("You are checking a whole AI persona"))).toHaveLength(1);
	});
});
