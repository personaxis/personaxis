/**
 * E116: the identity reaches every model that reads it whole.
 *
 * Measured on 2026-09-23. Three readers cut the compiled identity from the end, at 5.000
 * (the agent that works), 4.000 (the appraiser that decides how the persona evolves) and 6.000
 * (the responder). The bench persona's `PERSONA.md` is 5.780 characters, so the working model
 * had never read its own "Self-improvement" or "Above all" sections, and the judge of its
 * evolution had never read its limits. A cut from the end loses exactly what a document writes
 * as its summary, and nothing said it happened.
 *
 * The check is on what goes over the wire, not on the option passed in: a document long enough
 * to cross every old cut, whose last line has to arrive.
 */
import { describe, expect, it } from "vitest";

import { LlmAppraiser, LlmResponder, PersonaAgent } from "../src/index.js";

const TAIL = "## Above all\n\nThe last line of who you are, which a cut from the end used to drop.";
const LONG = `# You are Wright\n\n${"A sentence that fills the identity document. ".repeat(220)}\n\n${TAIL}`;

/** A model that answers once and keeps every request body it was sent. */
function capturing(content: string): { llm: { endpoint: string; model: string; fetchImpl: typeof fetch }; sent: string[] } {
	const sent: string[] = [];
	const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
		sent.push(String(init?.body ?? ""));
		return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10, prompt_tokens: 5 } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { llm: { endpoint: "http://stub", model: "stub-model", fetchImpl }, sent };
}

describe("the identity arrives whole (E116)", () => {
	it("is longer than every cut it used to meet", () => {
		// The fixture has to cross the largest old cut, or these tests prove nothing.
		expect(LONG.length).toBeGreaterThan(6000 + TAIL.length);
	});

	it("reaches the working agent to its last line", async () => {
		const { llm } = capturing("done");
		const agent = new PersonaAgent({ llm, personaBody: LONG });
		await agent.run("say done");
		const prefix = String(agent.lastMessages?.[0]?.content ?? "");
		expect(prefix).toContain(TAIL);
	});

	it("reaches the appraiser that decides how the persona evolves", async () => {
		const { llm, sent } = capturing(JSON.stringify({ confidence: 0.1, mutations: [] }));
		await new LlmAppraiser(llm).appraise({ observation: "hello", source: "user", personaBody: LONG, mutableFields: [] });
		expect(sent.join("\n")).toContain(JSON.stringify(TAIL).slice(1, -1));
	});

	it("reaches the responder", async () => {
		const { llm, sent } = capturing("hi");
		await new LlmResponder(llm).respond({ message: "hello", personaBody: LONG, memory: [], state: {}, name: "Wright" });
		expect(sent.join("\n")).toContain(JSON.stringify(TAIL).slice(1, -1));
	});
});
