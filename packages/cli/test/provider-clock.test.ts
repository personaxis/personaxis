/**
 * The clock has to fit the budget, or the two disagree and the budget always loses.
 *
 * Measured 2026-09-10 on the HuggingFace router: `google/gemma-3-4b-it` sustains 24 to 28
 * completion tokens per second. The provider asks for up to 8192 tokens, which is about five
 * and a half minutes at that rate, while `postJson` defaulted to a 120-second clock covering
 * roughly 3000 of them. A persona polish therefore died on the clock while the budget was
 * never the problem, and the error said "the operation was aborted due to timeout", which
 * names the mechanism and hides the cause.
 *
 * And a timeout used to be retried the full three times. A request that ran out of time
 * against a model producing 25 tokens a second runs out again; three attempts buy three
 * times the wait for the same answer.
 */

import { describe, expect, it, vi } from "vitest";

import { budgetFor, timeoutFor } from "../src/providers/local.js";
import { postJson } from "../src/providers/http.js";

describe("the timeout is derived from the budget", () => {
	it("covers a full 8192-token completion at the measured floor rate", () => {
		// 8192 tokens at the 15 t/s floor is ~546 s. A clock shorter than that is a clock that
		// cancels answers the provider itself asked for.
		expect(timeoutFor(8192)).toBeGreaterThan(8192 / 25 * 1000);
	});

	it("keeps a floor, so a tiny budget does not get a hair-trigger clock", () => {
		expect(timeoutFor(100)).toBe(120_000);
	});

	it("keeps a ceiling, so a hung endpoint does not hold the CLI for ten minutes", () => {
		expect(timeoutFor(1_000_000)).toBe(600_000);
	});

	it("grows with the budget rather than being a constant in disguise", () => {
		expect(timeoutFor(8192)).toBeGreaterThan(timeoutFor(2048));
	});
});

describe("the budget fits what the endpoint can finish", () => {
	it("gives a local server the full budget, because nothing sits in front of it", () => {
		expect(budgetFor("http://localhost:11434/v1")).toBe(8192);
		expect(budgetFor("http://127.0.0.1:8080/v1")).toBe(8192);
	});

	it("keeps a hosted router inside its gateway's patience", () => {
		// Measured: 4096 finished in 87 s, 8192 came back 504 with the model still working.
		expect(budgetFor("https://router.huggingface.co/v1")).toBe(4096);
	});

	it("does not overrule an explicit choice, which is the operator's to make", () => {
		expect(budgetFor("https://router.huggingface.co/v1", 16384)).toBe(16384);
		expect(budgetFor("http://localhost:11434/v1", 512)).toBe(512);
	});

	it("pairs a smaller hosted budget with a shorter clock, so the two agree", () => {
		expect(timeoutFor(budgetFor("https://router.huggingface.co/v1"))).toBeLessThan(
			timeoutFor(budgetFor("http://localhost:11434/v1")),
		);
	});
});

describe("a timeout is not retried like a rate limit", () => {
	const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

	it("tries twice and stops, instead of spending the whole retry budget", async () => {
		const fetchImpl = vi.fn(async () => {
			throw timeoutError();
		});
		await expect(
			postJson("https://x/v1/chat/completions", {}, {}, { fetchImpl: fetchImpl as never, sleep: async () => {}, retries: 2 }),
		).rejects.toThrow(/timed out/);
		// One attempt plus one retry. The third would buy the same answer at twice the wait.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("still spends the full budget on a rate limit, which is a blip and not a slow model", async () => {
		const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, statusText: "Too Many Requests", text: async () => "" }) as never);
		await expect(
			postJson("https://x/v1/chat/completions", {}, {}, { fetchImpl: fetchImpl as never, sleep: async () => {}, retries: 2 }),
		).rejects.toThrow(/429/);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("names the cause and the fix instead of the mechanism", async () => {
		const fetchImpl = vi.fn(async () => {
			throw timeoutError();
		});
		const err = await postJson("https://x/v1/chat/completions", {}, {}, {
			fetchImpl: fetchImpl as never,
			sleep: async () => {},
			retries: 0,
			timeoutMs: 120_000,
		}).catch((e: Error) => e);
		expect(err.message).toMatch(/tokens\/second/);
		expect(err.message).toMatch(/maxTokens|Raise the timeout/);
	});

	describe("the control of the control", () => {
		it("the old message named the mechanism and hid the cause", () => {
			const old = "The operation was aborted due to timeout";
			expect(old).not.toMatch(/token|maxTokens|model/i);
		});
	});
});
