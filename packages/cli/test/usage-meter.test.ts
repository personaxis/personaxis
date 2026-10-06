/**
 * Counting model calls where every one of them passes.
 *
 * Needed because a service step's cost is not one call: the answer, the appraiser of the governed
 * tick and the naming of a new session each build their own request. Tokens and time per step are
 * what a comparison of cost needs, and before this the journal of a run recorded only time.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { meterModelCalls, usageBetween } from "../src/usage-meter.js";

const realFetch = globalThis.fetch;

function respond(body: unknown, type = "application/json", status = 200): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });
}

let answers: Response[] = [];
beforeEach(() => {
	answers = [];
	globalThis.fetch = (async () => answers.shift() ?? respond({})) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("the usage meter", () => {
	it("adds up the usage block of every chat completion", async () => {
		const meter = meterModelCalls();
		answers.push(respond({ usage: { prompt_tokens: 100, completion_tokens: 20 } }));
		answers.push(respond({ usage: { prompt_tokens: 50, completion_tokens: 5 } }));
		await fetch("https://router.example/v1/chat/completions", { method: "POST" });
		await fetch("https://router.example/v1/chat/completions", { method: "POST" });
		expect(meter.snapshot()).toEqual({ calls: 2, promptTokens: 150, completionTokens: 25, unreported: 0 });
		meter.stop();
	});

	it("leaves the caller's copy of the body readable", async () => {
		const meter = meterModelCalls();
		answers.push(respond({ usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ message: { content: "hi" } }] }));
		const res = await fetch("http://localhost:11434/v1/chat/completions");
		const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
		expect(body.choices[0]?.message.content).toBe("hi");
		meter.stop();
	});

	it("does not count calls that are not chat completions", async () => {
		const meter = meterModelCalls();
		answers.push(respond({ usage: { prompt_tokens: 999, completion_tokens: 999 } }));
		await fetch("https://router.example/v1/models");
		expect(meter.snapshot().calls).toBe(0);
		meter.stop();
	});

	it("counts a call without a usage block as unreported, never as zero tokens", async () => {
		const meter = meterModelCalls();
		answers.push(respond({ choices: [] }));
		answers.push(respond("data: {}\n\ndata: [DONE]\n\n", "text/event-stream"));
		answers.push(respond({ error: "overloaded" }, "application/json", 429));
		await fetch("https://router.example/v1/chat/completions");
		await fetch("https://router.example/v1/chat/completions");
		await fetch("https://router.example/v1/chat/completions");
		expect(await meter.settled()).toEqual({ calls: 3, promptTokens: 0, completionTokens: 0, unreported: 3 });
		meter.stop();
	});

	it("reads a stream's usage from its last chunk, and leaves the stream to its reader", async () => {
		// The engine's tool-calling loop streams whenever something listens, with include_usage,
		// and the first real service run reported all sixteen of its working calls as unreported.
		const meter = meterModelCalls();
		const sse = [
			'data: {"choices":[{"delta":{"content":"Hel"}}],"usage":null}',
			'data: {"choices":[{"delta":{"content":"lo"}}],"usage":null}',
			'data: {"choices":[],"usage":{"prompt_tokens":321,"completion_tokens":12}}',
			"data: [DONE]",
			"",
		].join("\n\n");
		answers.push(respond(sse, "text/event-stream"));
		const res = await fetch("https://router.example/v1/chat/completions");
		// The caller's copy is the whole stream, untouched.
		expect(await res.text()).toBe(sse);
		expect(await meter.settled()).toEqual({ calls: 1, promptTokens: 321, completionTokens: 12, unreported: 0 });
		meter.stop();
	});

	it("measures what happened between two snapshots", async () => {
		const meter = meterModelCalls();
		answers.push(respond({ usage: { prompt_tokens: 10, completion_tokens: 1 } }));
		await fetch("https://router.example/v1/chat/completions");
		const before = meter.snapshot();
		answers.push(respond({ usage: { prompt_tokens: 7, completion_tokens: 3 } }));
		await fetch("https://router.example/v1/chat/completions");
		expect(usageBetween(before, meter.snapshot())).toEqual({ calls: 1, promptTokens: 7, completionTokens: 3, unreported: 0 });
		meter.stop();
	});

	describe("putting fetch back", () => {
		it("restores the fetch it replaced", () => {
			const before = globalThis.fetch;
			const meter = meterModelCalls();
			expect(globalThis.fetch).not.toBe(before);
			meter.stop();
			expect(globalThis.fetch).toBe(before);
		});

		it("does not remove a wrapper installed after it", () => {
			const meter = meterModelCalls();
			const later = (async () => respond({})) as typeof fetch;
			globalThis.fetch = later;
			meter.stop();
			expect(globalThis.fetch).toBe(later);
		});
	});
});
