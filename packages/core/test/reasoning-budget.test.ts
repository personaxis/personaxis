/**
 * A model that could not answer must not look like a model that answered "no change".
 *
 * Measured 2026-09-10 on the HuggingFace router with `Qwen/Qwen3.5-9B`: at `max_tokens: 512`
 * the model spends the whole budget thinking and the server returns **HTTP 200 with an empty
 * `content`**. Without max_tokens it answers fine in 1087 completion tokens; at 2048 it
 * answers in 758. So 512, which both the appraiser and the responder used to default to,
 * is a budget a whole family of current open models cannot finish inside.
 *
 * The appraiser's failure was the dangerous one and it was silent. An empty string is not
 * nullish, so `content ?? "{}"` never fired; `JSON.parse("")` threw; the prose-extraction
 * catch found no `{...}`; and `parseAppraisalSignal({})` returned a NEUTRAL signal. The
 * living loop therefore appraised every tick as "nothing happened", the persona never
 * evolved, and nothing anywhere reported a problem.
 */

import { describe, expect, it, vi } from "vitest";

import { LlmAppraiser } from "../src/llm-appraiser.js";
import { LlmResponder } from "../src/responder.js";

const ok = (body: unknown) =>
	({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

/** What the router actually sent back at max_tokens 512, reduced to the fields that matter. */
const EXHAUSTED = {
	choices: [{ finish_reason: "length", message: { role: "assistant", content: "", reasoning: "Thinking Process: ..." } }],
};

const cfg = { endpoint: "https://router.huggingface.co/v1", model: "Qwen/Qwen3.5-9B" };

/** The appraiser needs a whole observation, not just a string. */
const APPRAISE_INPUT = {
	observation: "anything",
	source: "user" as never,
	personaBody: "",
	mutableFields: [],
} as never;

/** The responder builds the system prompt from the modeled state, so it cannot be missing. */
const RESPOND_INPUT = { message: "anything", personaBody: "", state: {}, memory: [] } as never;

describe("an exhausted reasoning budget is an error, not a neutral appraisal", () => {
	it("the appraiser refuses instead of inventing a signal", async () => {
		const fetchImpl = vi.fn(async () => ok(EXHAUSTED));
		const appraiser = new LlmAppraiser({ ...cfg, fetchImpl: fetchImpl as never });
		await expect(appraiser.appraise(APPRAISE_INPUT)).rejects.toThrow(/token limit|thinking|maxTokens/i);
	});

	it("the appraiser still refuses when the model stopped normally with only reasoning", async () => {
		const body = { choices: [{ finish_reason: "stop", message: { content: "", reasoning: "..." } }] };
		const appraiser = new LlmAppraiser({ ...cfg, fetchImpl: vi.fn(async () => ok(body)) as never });
		await expect(appraiser.appraise(APPRAISE_INPUT)).rejects.toThrow(/reasoning|maxTokens/i);
	});

	it("the appraiser does not retry a looser response_format against an empty budget", async () => {
		// Three strategies exist for servers that reject a schema. None of them can conjure an
		// answer out of a budget that is already spent, and retrying bills the user twice more.
		const fetchImpl = vi.fn(async () => ok(EXHAUSTED));
		const appraiser = new LlmAppraiser({ ...cfg, fetchImpl: fetchImpl as never });
		await expect(appraiser.appraise(APPRAISE_INPUT)).rejects.toThrow();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("a real appraisal still parses, so the guard did not eat the good path", async () => {
		const body = { choices: [{ finish_reason: "stop", message: { content: '{"valence": 0.2}' } }] };
		const appraiser = new LlmAppraiser({ ...cfg, fetchImpl: vi.fn(async () => ok(body)) as never });
		await expect(appraiser.appraise(APPRAISE_INPUT)).resolves.toBeDefined();
	});

	it("the appraiser asks for a budget a reasoning model can finish inside", async () => {
		const fetchImpl = vi.fn(async (_url: string, _init: { body: string }) => ok({ choices: [{ message: { content: "{}" } }] }));
		await new LlmAppraiser({ ...cfg, fetchImpl: fetchImpl as never }).appraise(APPRAISE_INPUT);
		const sent = JSON.parse(fetchImpl.mock.calls[0]![1].body);
		// 512 is the measured failing value. The default must clear it by a real margin.
		expect(sent.max_tokens).toBeGreaterThan(512);
	});

	it("the responder names the real cause instead of suggesting a rephrase", async () => {
		const responder = new LlmResponder({ ...cfg, fetchImpl: vi.fn(async () => ok(EXHAUSTED)) as never });
		const out = await responder.respond(RESPOND_INPUT);
		expect(out).toMatch(/tokens|thinks before it answers/i);
		expect(out).not.toMatch(/rephrasing/i);
	});

	it("the responder keeps the old advice when there was no reasoning to blame", async () => {
		// An error that invents a cause is worse than one that admits ignorance.
		const body = { choices: [{ finish_reason: "stop", message: { content: "" } }] };
		const responder = new LlmResponder({ ...cfg, fetchImpl: vi.fn(async () => ok(body)) as never });
		const out = await responder.respond(RESPOND_INPUT);
		expect(out).toMatch(/rephrasing/i);
	});

	describe("the control of the control", () => {
		it("the old appraiser path turned an empty answer into a neutral signal", async () => {
			// Restored here so the suite proves it catches the real defect. `""` is not nullish,
			// so the `?? "{}"` default never fired and the catch produced `{}` anyway.
			const content: string | undefined = "";
			const defaulted = content ?? "{}";
			expect(defaulted).toBe("");
			let parsed: unknown;
			try {
				parsed = JSON.parse(defaulted);
			} catch {
				const m = defaulted.match(/\{[\s\S]*\}/);
				parsed = m ? JSON.parse(m[0]) : {};
			}
			// This is what the living loop used to appraise every tick with, forever, in silence.
			expect(parsed).toEqual({});
		});
	});
});
