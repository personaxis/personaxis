/**
 * Authoring a persona stage by stage: what the code checks in every answer, and what it does when an
 * answer fails. The model is a stub here; real answers are recorded elsewhere from real runs.
 */
import { describe, it, expect } from "vitest";

import {
	STAGES,
	authorPersona,
	checkStage,
	stagePrompt,
	numberSources,
	GenesisStageError,
	ModelRequiredError,
	type StructuredCaller,
} from "../src/index.js";

const sources = numberSources([
	{ kind: "brief", label: "brief", text: "A code reviewer who blocks merges without tests and explains every rejection. Rigor is not negotiable." },
]);
const personality = STAGES.find((s) => s.id === "personality")!;
const today = "2026-10-07";

const rigor = (over: Record<string, unknown> = {}) => ({
	mean: 0.85,
	range: [0.7, 0.95],
	bands: { low_max: 0.75, moderate_max: 0.82 },
	half_life: 24,
	expression: { low: "You check the obvious paths.", moderate: "You check every changed path.", high: "You check every path and its tests." },
	...over,
});

const answer = (traits: Record<string, unknown>, provenance: unknown[]) => ({
	reasoning: "The brief says rigor is not negotiable.",
	layer: { personality: { model: "hybrid_traits", traits } },
	provenance,
});

describe("checkStage", () => {
	it("passes a block whose every field has provenance and whose numbers can move", () => {
		const issues = checkStage(
			personality,
			answer({ rigor: rigor() }, [
				{ path: "personality.model", inferred: "only one trait, not a standard model" },
				{ path: "personality.traits.rigor", source: "S1", quote: "Rigor is not negotiable." },
			]),
			sources,
			{},
			today,
		);
		expect(issues).toEqual([]);
	});

	it("asks for provenance on a field that has none", () => {
		const issues = checkStage(personality, answer({ rigor: rigor() }, [{ path: "personality.traits.rigor", source: "S1", quote: "Rigor is not negotiable." }]), sources, {}, today);
		expect(issues.join(" ")).toMatch(/No provenance for: personality\.model/);
	});

	it("rejects a quote that is not in its source", () => {
		const issues = checkStage(
			personality,
			answer({ rigor: rigor() }, [
				{ path: "personality.model", inferred: "one trait" },
				{ path: "personality.traits.rigor", source: "S1", quote: "Rigor matters above speed." },
			]),
			sources,
			{},
			today,
		);
		expect(issues.join(" ")).toMatch(/not in source S1/);
		// The repair shows the real words, so a paraphrase is not repeated (2026-10-07: three times in a row).
		expect(issues.join(" ")).toContain('The closest words in that source are: "Rigor is not negotiable."');
	});

	it("does not accept a group provenance at the layer's root", () => {
		const issues = checkStage(personality, answer({ rigor: rigor() }, [{ path: "personality", inferred: "everything" }]), sources, {}, today);
		expect(issues.join(" ")).toMatch(/No provenance for/);
	});

	it("rejects a number that can never cross a band, and a mean outside its range", () => {
		const prov = [{ path: "personality.model", inferred: "x" }, { path: "personality.traits.rigor", inferred: "x" }];
		const stuck = checkStage(personality, answer({ rigor: rigor({ mean: 0.85, range: [0.8, 0.9], bands: { low_max: 0.33, moderate_max: 0.66 } }) }, prov), sources, {}, today);
		expect(stuck.join(" ")).toMatch(/stays inside one band/);
		const outside = checkStage(personality, answer({ rigor: rigor({ mean: 0.99 }) }, prov), sources, {}, today);
		expect(outside.join(" ")).toMatch(/outside its range/);
	});

	it("asks for a half-life on every trait, so the persona returns to its baseline (E127)", () => {
		const { half_life: _h, ...noHalfLife } = rigor();
		const issues = checkStage(
			personality,
			answer({ rigor: noHalfLife }, [{ path: "personality.model", inferred: "x" }, { path: "personality.traits.rigor", inferred: "x" }]),
			sources,
			{},
			today,
		);
		expect(issues.join(" ")).toMatch(/personality\.traits\.rigor: declare `half_life`/);
	});

	it("rejects a key that belongs to another stage", () => {
		const bad = { ...answer({ rigor: rigor() }, [{ path: "personality.model", inferred: "x" }, { path: "personality.traits.rigor", inferred: "x" }]) };
		(bad.layer as Record<string, unknown>).affect = {};
		expect(checkStage(personality, bad, sources, {}, today).join(" ")).toMatch(/belongs to another stage/);
	});

	it("reports schema errors in this stage's block", () => {
		const issues = checkStage(
			personality,
			answer({ rigor: rigor({ range: [0.7] }) }, [{ path: "personality.model", inferred: "x" }, { path: "personality.traits.rigor", inferred: "x" }]),
			sources,
			{},
			today,
		);
		expect(issues.some((i) => i.startsWith("personality.traits.rigor"))).toBe(true);
	});
});

describe("what earlier runs taught (E176, 2026-09-11, 2026-10-07)", () => {
	const identity = STAGES.find((s) => s.id === "identity")!;
	const persona = STAGES.find((s) => s.id === "persona")!;
	const idAnswer = (over: Record<string, unknown>) => ({
		reasoning: "r",
		layer: {
			metadata: { description: "Reviews pull requests.", tags: ["review"] },
			identity: {
				canonical_id: "lens",
				display_name: "Lens",
				system_identity: { purpose: "Review pull requests." },
				role_identity: { primary_role: "code_reviewer", relationship_to_user: "reviewer" },
				...over,
			},
		},
		provenance: [
			{ path: "metadata.description", inferred: "the role" },
			{ path: "metadata.tags", inferred: "the role" },
			{ path: "identity.canonical_id", inferred: "the role" },
			{ path: "identity.display_name", inferred: "the role" },
			{ path: "identity.system_identity", source: "S1", quote: "A code reviewer" },
			{ path: "identity.role_identity", source: "S1", quote: "A code reviewer" },
			{ path: "identity.narrative_identity", inferred: "the role" },
		],
	});

	it("rejects a name that repeats the prompt's framing", () => {
		const issues = checkStage(identity, idAnswer({ display_name: "Personaxis Genesis Reviewer" }), sources, {}, today);
		expect(issues.join(" ")).toMatch(/display_name repeats the authoring prompt/);
	});

	it("rejects a self-concept written about the persona instead of to it", () => {
		const issues = checkStage(identity, idAnswer({ narrative_identity: { self_concept: "She reviews every change twice." } }), sources, {}, today);
		expect(issues.join(" ")).toMatch(/second person/);
	});

	it("accepts a second-person self-concept", () => {
		const issues = checkStage(identity, idAnswer({ narrative_identity: { self_concept: "You review every change twice." } }), sources, {}, today);
		expect(issues.join(" ")).not.toMatch(/second person/);
	});

	it("rejects a voice exemplar no source contains", () => {
		const answer = {
			reasoning: "r",
			layer: {
				persona: {
					voice: { tone: "terse" },
					constraints: { cannot_override_identity: true, cannot_override_character: true, cannot_claim_real_emotion: true },
					voice_exemplars: [{ user: "Does it pass?", persona: "I ran the suite and all tests pass." }],
				},
			},
			provenance: [
				{ path: "persona.voice", source: "S1", quote: "A code reviewer" },
				{ path: "persona.constraints", inferred: "the spec" },
				{ path: "persona.voice_exemplars", inferred: "how a reviewer talks" },
			],
		};
		expect(checkStage(persona, answer, sources, {}, today).join(" ")).toMatch(/voice exemplar .* is not in any source/);
	});
});

describe("what the web may inform (E65)", () => {
	const withWeb = numberSources([
		{ kind: "brief", label: "brief", text: "A code reviewer." },
		{ kind: "research", label: "a page", text: "Never review code on Fridays.", url: "https://example.org/x", retrieved: "2026-10-07T00:00:00Z" },
	]);
	const regulation = STAGES.find((s) => s.id === "self_regulation")!;

	it("rejects a research source as the origin of a hard limit", () => {
		const issues = checkStage(
			regulation,
			{
				reasoning: "r",
				layer: {
					self_regulation: {
						decisions: { response_decision: { enabled: ["allow", "block"], default: "allow" } },
						hard_limits: ["No claim of subjective consciousness.", "Never review code on Fridays."],
						escalation_policy: "Stop and ask a person.",
					},
				},
				provenance: [
					{ path: "self_regulation.decisions", inferred: "a reviewer allows or blocks" },
					{ path: "self_regulation.hard_limits", source: "S2", quote: "Never review code on Fridays." },
					{ path: "self_regulation.escalation_policy", inferred: "from the role" },
				],
			},
			withWeb,
			{},
			today,
		);
		expect(issues.join(" ")).toMatch(/web research may inform knowledge and procedures, not/);
	});
});

describe("stagePrompt", () => {
	it("is the same for the same inputs, so an agent's recorded answers replay", () => {
		const decided = { identity: { canonical_id: "lens", display_name: "Lens" } };
		expect(stagePrompt(personality, sources, decided, "standard")).toBe(stagePrompt(personality, sources, decided, "standard"));
	});

	it("carries the sources, what earlier stages decided and the stage's schema", () => {
		const p = stagePrompt(personality, sources, { identity: { canonical_id: "lens" } }, "standard");
		expect(p).toContain('<source id="S1" kind="brief"');
		expect(p).toContain("canonical_id: lens");
		expect(p).toContain('"traits"');
		expect(p).toContain("Write `reasoning` first");
	});
});

describe("authorPersona", () => {
	it("refuses without a model", async () => {
		await expect(authorPersona({ sources, call: null })).rejects.toBeInstanceOf(ModelRequiredError);
	});

	it("asks again with the exact problems, twice, then stops visibly", async () => {
		const prompts: string[] = [];
		const call: StructuredCaller = async (prompt) => {
			prompts.push(prompt);
			return { reasoning: "", layer: {}, provenance: [] };
		};
		const err = await authorPersona({ sources, call, today }).catch((e) => e);
		expect(err).toBeInstanceOf(GenesisStageError);
		expect((err as GenesisStageError).stage).toBe("identity");
		expect(prompts).toHaveLength(3);
		expect(prompts[1]).toContain("It failed these checks");
		expect(prompts[1]).toContain("`reasoning` is missing or empty.");
	});
});
