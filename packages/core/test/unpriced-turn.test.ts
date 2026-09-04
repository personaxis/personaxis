/**
 * A turn nobody priced, and a turn that cost nothing, are different facts.
 *
 * E34, and it came out of E32's type errors rather than out of reading the code. The
 * claim above is written into `costOf` at length and `TurnOutcome.cost` is optional
 * because of it. Both were dead: `AgentBudgetReport.tokens` and `.costUsd` were required
 * NUMBERS, so a provider that reported no usage was written down as having cost zero one
 * layer below where anybody could tell, and `costOf`'s two careful branches could never
 * be taken. The distinction was defended at the seam and destroyed before it got there.
 *
 * What makes it reachable is one bit the loop already had and never kept: whether any
 * provider call reported usage at all. Tracked beside the total rather than read off the
 * meter, because the meter was only ever told about the step calls, and the planning call
 * is a model call too. That is a second thing this fixes: every cache report the loop has
 * produced was missing the planning call.
 *
 * Steps and wall seconds stay required, and the asymmetry is the point. The runtime
 * counts those itself whatever the provider says; only the provider can say what it
 * charged.
 */

import { describe, expect, it } from "vitest";

import { PersonaAgent } from "../src/agent.js";
import { productOf } from "../src/run/default-provider.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

/** A model that answers once, with or without saying what it cost. */
function model(usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
	return {
		endpoint: "http://x/v1",
		model: "m",
		fetchImpl: (async (url: string) => {
			if (String(url).endsWith("/models")) {
				return { ok: true, status: 200, json: async () => ({ data: [] }) };
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({
					choices: [{ message: { content: "done" } }],
					...(usage ? { usage } : {}),
				}),
			};
		}) as unknown as typeof fetch,
	};
}

function agentOn(usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
	return new PersonaAgent({
		llm: model(usage),
		policy: { ...DEFAULT_POLICY, workspaceRoot: process.cwd() },
		personaBody: "You are a tester.",
		maxSteps: 1,
	});
}

describe("what the loop says a run cost", () => {
	it("says nothing when no call reported usage", async () => {
		const result = await agentOn().run("say something");

		expect(result.budget.tokens).toBeUndefined();
		expect(result.budget.costUsd).toBeUndefined();
	});

	it("still counts what the runtime counts itself", async () => {
		// The asymmetry, asserted rather than assumed. An absent price is not an absent
		// turn: the steps and the clock belong to the runtime and are always there.
		const result = await agentOn().run("say something");

		expect(typeof result.budget.wallSeconds).toBe("number");
		expect(result.budget.steps).toBeGreaterThanOrEqual(0);
	});

	it("reports a price when a call gave one, zeros included", async () => {
		// Zero here IS a measurement: somebody looked and the turn was free. That is the
		// half of the distinction that would be lost by treating absent as zero, and it is
		// lost in the other direction just as easily.
		const result = await agentOn({
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		}).run("say something");

		expect(result.budget.tokens).toBe(0);
		expect(result.budget.costUsd).toBe(0);
	});

	it("adds up what was reported", async () => {
		const result = await agentOn({
			prompt_tokens: 120,
			completion_tokens: 30,
			total_tokens: 150,
		}).run("say something");

		expect(result.budget.tokens).toBe(150);
	});
});

describe("what the seam does with it", () => {
	it("carries no cost for a run nobody priced", async () => {
		// The branch `costOf` was written for, taken for the first time. Before this it
		// was unreachable through the declared types.
		const product = productOf(await agentOn().run("say something"));

		expect("cost" in product).toBe(false);
	});

	it("carries a cost of zero for a run somebody priced at zero", async () => {
		const product = productOf(
			await agentOn({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }).run("say it"),
		);

		expect(product.cost).toEqual({ tokens: 0, usd: 0 });
	});
});

describe("what the meter was never shown", () => {
	it("counts EVERY model call, and used to miss the planning one", async () => {
		// Not a tidiness point: the cache report is the instrument E18 built to say
		// whether the stable prefix is being served from cache, and the planning call runs
		// against that same prefix. A report that never saw it was measuring a subset and
		// saying nothing about it.
		let asked = 0;
		const agent = new PersonaAgent({
			llm: {
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: (async (url: string) => {
					if (String(url).endsWith("/models")) {
						return { ok: true, status: 200, json: async () => ({ data: [] }) };
					}
					asked += 1;
					return {
						ok: true,
						status: 200,
						json: async () => ({
							choices: [{ message: { content: "done" } }],
							usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
						}),
					};
				}) as unknown as typeof fetch,
			},
			policy: { ...DEFAULT_POLICY, workspaceRoot: process.cwd() },
			personaBody: "You are a tester.",
			maxSteps: 1,
			plan: { enabled: true },
		});

		const result = await agent.run("say something");

		// The count, not "more than zero". A report that saw one of two calls is a report
		// about a subset, and it says nothing about being one.
		expect(asked).toBeGreaterThan(1);
		expect(result.cache.calls).toBe(asked);
	});
});
