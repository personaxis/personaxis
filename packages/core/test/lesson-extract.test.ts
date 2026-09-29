/**
 * E88: asking the persona what it learned, with its own model, and never inventing the answer.
 *
 * The pure half is checked in `lesson.test.ts`. What these pin is the call: that it asks without a catalogue,
 * that a readable answer becomes a lesson, and that everything else becomes nothing at all.
 */
import { describe, expect, it } from "vitest";

import { lessonFrom } from "../src/run/lesson-extract.js";

type Sent = { messages: Array<{ role: string; content?: unknown }>; tools?: unknown[] };

/** A model that answers with one text, and keeps what it was sent. */
function scripted(text: string): { llm: never; sent: Sent[] } {
	const sent: Sent[] = [];
	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		sent.push(JSON.parse(init?.body ?? "{}") as Sent);
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text }, finish_reason: "stop" }] }) };
	}) as unknown as typeof fetch;

	return { llm: { endpoint: "http://x/v1", model: "m", fetchImpl } as never, sent };
}

const lesson = JSON.stringify({
	reusable: true,
	name: "Fix a crashing page",
	description: "when a page dies a few seconds in",
	capabilities: ["debugging a browser game"],
	allowed_tools: ["read_file", "check_page"],
	body: "1. Run the page.\n2. Read the first error.\n3. Fix the call it names.",
});

const input = { task: "fix the game", transcript: "assistant: I ran it and it crashed", outcome: "success" as const, toolsUsed: ["check_page"] };

describe("asking the persona what it learned (E88)", () => {
	it("returns the lesson the persona wrote", async () => {
		const model = scripted(lesson);
		const got = await lessonFrom(model.llm)(input);

		expect(got).toMatchObject({ name: "Fix a crashing page", allowedTools: ["read_file", "check_page"] });
	});

	it("asks one short question with no tools, so the model answers instead of going back to work", async () => {
		const model = scripted(lesson);
		await lessonFrom(model.llm)(input);

		expect(model.sent[0]?.tools ?? []).toEqual([]);
		expect(JSON.stringify(model.sent[0]?.messages)).toContain("reusable");
		expect(JSON.stringify(model.sent[0]?.messages)).toContain("fix the game");
	});

	it("asks a hybrid model not to think, through the switch its destination declares (E147)", async () => {
		// Qwen 3.5 thought 1.650 to 4.096 tokens on this question and ran to the ceiling 3 times in 17 (2026-09-29).
		const model = scripted(lesson);
		await lessonFrom({ ...(model.llm as object), endpoint: "https://router.huggingface.co/v1", model: "Qwen/Qwen3.5-9B" } as never)(input);

		expect((model.sent[0] as Record<string, unknown>).chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it("and sends nothing extra to a destination that declared no switch", async () => {
		const model = scripted(lesson);
		await lessonFrom(model.llm)(input);

		expect((model.sent[0] as Record<string, unknown>).chat_template_kwargs).toBeUndefined();
	});

	it("returns nothing when the persona says the method is not worth keeping", async () => {
		const model = scripted(JSON.stringify({ reusable: false, name: "x", body: "y" }));

		expect(await lessonFrom(model.llm)(input)).toBeNull();
	});

	it("returns nothing when the reply cannot be read, rather than writing a skill out of prose", async () => {
		// A skill invented by the runtime and filed under the persona's name would be durable, and nobody
		// reading it later could tell it was not the persona's.
		for (const said of ["", "I think we learned a lot today", "{ not json }"]) {
			const model = scripted(said);
			expect(await lessonFrom(model.llm)(input)).toBeNull();
		}
	});
});
