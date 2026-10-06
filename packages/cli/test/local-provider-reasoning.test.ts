/**
 * A reasoning model that ran out of budget must say so, not "returned no content".
 *
 * The 2026 generation of open models thinks before it answers and the thinking is billed
 * against the same completion budget. When the budget runs out mid-thought the server
 * answers HTTP 200 with an empty `content` and `finish_reason: "length"`. Measured on the
 * HuggingFace router with `Qwen/Qwen3.5-9B` on 2026-09-10: the two-token answer "ok" cost
 * 254 completion tokens of reasoning, and `usage.reasoning_tokens` came back 0, so the usage
 * block does not locate the spend either.
 *
 * This is the difference between a one-line config change and an afternoon of thinking the
 * endpoint is broken, which is why it is a test and not a comment.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const postJson = vi.fn();
vi.mock("../src/providers/http.js", () => ({ postJson: (...a: unknown[]) => postJson(...a) }));

const ENDPOINT = "https://router.huggingface.co/v1";

async function runWith(response: unknown): Promise<string> {
	postJson.mockResolvedValueOnce(response);
	const { createLocalProvider } = await import("../src/providers/local.js");
	const provider = createLocalProvider({ local: { endpoint: ENDPOINT, model: "Qwen/Qwen3.5-9B" } } as never);
	try {
		await provider.run("anything");
		return "";
	} catch (e) {
		return (e as Error).message;
	}
}

describe("the local provider explains an empty answer", () => {
	beforeEach(() => {
		postJson.mockReset();
		vi.resetModules();
	});
	afterEach(() => vi.restoreAllMocks());

	it("names the token limit when the model stopped for length", async () => {
		const message = await runWith({
			model: "Qwen/Qwen3.5-9B",
			choices: [{ finish_reason: "length", message: { role: "assistant", content: "", reasoning: "Thinking Process: ..." } }],
		});
		expect(message).toContain("token limit");
		expect(message).toContain("max_tokens");
		// The thinking is named, because that is the part a reader does not expect to be billed.
		expect(message).toMatch(/thinking/i);
	});

	it("names the reasoning when the answer is missing but the model stopped normally", async () => {
		const message = await runWith({
			model: "Qwen/Qwen3.5-9B",
			choices: [{ finish_reason: "stop", message: { role: "assistant", content: "", reasoning: "Thinking Process: ..." } }],
		});
		expect(message).toContain("reasoning");
		expect(message).toContain("max_tokens");
	});

	it("also reads the reasoning_content spelling, which is the other half of the wild", async () => {
		const message = await runWith({
			choices: [{ finish_reason: "stop", message: { role: "assistant", content: "", reasoning_content: "..." } }],
		});
		expect(message).toContain("reasoning");
	});

	it("stays quiet about reasoning when there was none, rather than guessing a cause", async () => {
		// A server that returns an empty message for its own reasons must not be told it has a
		// reasoning model. An error that invents a cause is worse than one that admits ignorance.
		const message = await runWith({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] });
		expect(message).toContain("returned no content");
		expect(message).not.toMatch(/reasoning|token limit/i);
	});

	it("returns the answer untouched when there is one", async () => {
		postJson.mockResolvedValueOnce({
			model: "Qwen/Qwen3.5-9B",
			choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok", reasoning: "Thinking Process: ..." } }],
		});
		const { createLocalProvider } = await import("../src/providers/local.js");
		const provider = createLocalProvider({ local: { endpoint: ENDPOINT, model: "Qwen/Qwen3.5-9B" } } as never);
		const out = await provider.run("anything");
		// The reasoning is diagnostics, never the answer: a persona compiled from a model's
		// chain of thought would be a persona built out of its scratch paper.
		expect(out.text).toBe("ok");
		expect(out.text).not.toMatch(/Thinking Process/);
	});

	describe("the control of the control", () => {
		it("the old message carried no cause at all", async () => {
			// What a reader got before: true, and useless for the most likely 2026 reason.
			const old = `Local provider at ${ENDPOINT} returned no content.`;
			expect(old).not.toMatch(/max_tokens|reasoning|token limit/i);
		});
	});
});
