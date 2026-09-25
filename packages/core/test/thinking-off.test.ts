/**
 * E140: the calls after a turn tell a destination not to think, only when it declared how.
 *
 * Measured 2026-09-24 with Qwen3.5-9B on HuggingFace's router: the title and the appraisal came back empty on every run
 * of the bench, their whole ceiling spent thinking. What is checked is the body each fake provider RECEIVED: the switch
 * for the one declared destination, and not a single new field for any other, because an endpoint that does not know a
 * field answers 400.
 */
import { describe, expect, it } from "vitest";

import { LlmAppraiser, nameSession } from "../src/index.js";
import { capabilitiesFor } from "../src/run/destinations.js";

const HF = "https://router.huggingface.co/v1";

/** A provider that records every body it receives and answers with a short, finished reply. */
function recording(content: string) {
	const bodies: Array<Record<string, unknown>> = [];
	const fetchImpl = (async (_url: string, init?: { body?: string }) => {
		bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
		return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "stop", message: { content } }] }) };
	}) as unknown as typeof fetch;
	return { bodies, fetchImpl };
}

describe("the calls after a turn and a model that thinks (E140)", () => {
	it("the title call tells Qwen 3.5 not to think, with or without the router's provider suffix", async () => {
		for (const model of ["Qwen/Qwen3.5-9B", "Qwen/Qwen3.5-9B:together"]) {
			const { bodies, fetchImpl } = recording("Fixing Game Startup Crash");
			await nameSession({ endpoint: HF, model, fetchImpl }, "The game stops working a few seconds after it starts.");
			expect(bodies[0]!.chat_template_kwargs).toEqual({ enable_thinking: false });
		}
	});

	it("the appraisal tells Qwen 3.5 not to think", async () => {
		const { bodies, fetchImpl } = recording("{}");
		await new LlmAppraiser({ endpoint: HF, model: "Qwen/Qwen3.5-9B", fetchImpl }).appraise({ observation: "o", source: "user", personaBody: "id", mutableFields: [] });
		expect(bodies[0]!.chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it("a destination that declared nothing receives no new field at all", async () => {
		for (const [endpoint, model] of [
			[HF, "Qwen/Qwen3-4B-Instruct-2507"],
			["https://api.cohere.ai/compatibility/v1", "command-a-03-2025"],
			["http://localhost:11434/v1", "qwen3:4b"],
			["https://api.openai.com/v1", "gpt-5"],
		] as const) {
			const title = recording("A Title");
			await nameSession({ endpoint, model, fetchImpl: title.fetchImpl }, "hello");
			expect(Object.keys(title.bodies[0]!).sort()).toEqual(["max_tokens", "messages", "model", "temperature"]);
			const appraisal = recording("{}");
			await new LlmAppraiser({ endpoint, model, fetchImpl: appraisal.fetchImpl }).appraise({ observation: "o", source: "user", personaBody: "id", mutableFields: [] });
			expect(appraisal.bodies[0]).not.toHaveProperty("chat_template_kwargs");
		}
	});

	it("the switch is data in the table, and the tool loop's capabilities are unchanged for Qwen 3.5", () => {
		const qwen = capabilitiesFor(HF, "Qwen/Qwen3.5-9B");
		expect(qwen.thinkingOff).toEqual({ chat_template_kwargs: { enable_thinking: false } });
		expect(qwen.effort).toEqual([]);
		expect(qwen.cacheSeconds).toBe(0);
		expect(qwen.scaffold).toBeUndefined();
		expect(capabilitiesFor(HF, "Qwen/Qwen3.5-9B-Extra:bad provider").thinkingOff).toBeUndefined();
	});
});
