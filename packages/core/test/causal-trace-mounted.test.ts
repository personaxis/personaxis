/**
 * "Why did it do that", answered from the run rather than reconstructed after it.
 *
 * `causal-trace.ts` has held the assembly since phase 4 and nothing built one, so the
 * record answered "what happened, in order" and nobody has ever asked that. What people
 * ask is why a particular command ran, and the answer lives across three things the
 * record kept as unrelated entries: the plan step that intended it, the call that
 * carried it out, and the verification that decided whether it worked.
 *
 * The whole design decision is that the link is made AT WRITE TIME. A reconstruction
 * matches a call to the nearest plan step by time, which is right until a step retries
 * or the model works out of order, and then it confidently attributes an action to an
 * intention it never had, in a document whose value is that it can be trusted.
 *
 * So attribution here is by the tool a step DECLARED, which is identity rather than
 * nearness, and it refuses to answer when two steps declared the same tool. These tests
 * are mostly about that refusal, because a wrong causal link is worse than none.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	DEFAULT_POLICY,
	PersonaAgent,
	compile,
	describeTrace,
	traceIsInteresting,
	unambiguousSteps,
	type CompiledPolicy,
} from "../src/index.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-trace-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function persona(over: Partial<CompiledPolicy> = {}) {
	return compile({
		persona_version_id: "pv",
		hash: "h",
		compiled_at: new Date().toISOString(),
		ttl_seconds: 3600,
		deny: [],
		allow: [],
		hard_limits: [],
		prohibited_behaviors: [],
		egress_allowlist: [],
		sandbox: "danger-full-access",
		approval: "never",
		gate_rules: [],
		...over,
	});
}

/** A model that plans, then makes these calls, then finishes. */
function planningThen(plan: unknown, calls: Array<{ tool: string; args: object }>): typeof fetch {
	let asked = 0;
	return (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) {
			return { ok: true, status: 200, json: async () => ({ data: [] }) };
		}
		// The planning phase asks for text and is recognised by its instruction, which
		// is how the loop itself tells the two questions apart.
		if (String(init?.body ?? "").includes("Before acting, plan")) {
			return {
				ok: true,
				status: 200,
				headers: new Headers({ "content-type": "application/json" }),
				json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
			};
		}
		const next = calls[asked] ?? { tool: "finish", args: { summary: "done" } };
		asked += 1;
		return {
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => ({
				choices: [
					{
						message: {
							content: "",
							tool_calls: [
								{
									id: `c${asked}`,
									type: "function",
									function: { name: next.tool, arguments: JSON.stringify(next.args) },
								},
							],
						},
					},
				],
			}),
		};
	}) as unknown as typeof fetch;
}

async function runWith(plan: unknown, calls: Array<{ tool: string; args: object }>) {
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl: planningThen(plan, calls) },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access" },
		capability: persona(),
		plan: { enabled: true },
		maxSteps: calls.length + 2,
	});
	return agent.run("do the thing");
}

describe("a call the plan named", () => {
	it("lands under the step that named its tool", async () => {
		const result = await runWith(
			[
				{ tool: "list_dir", args: { path: "." }, note: "look around first" },
				{ tool: "write_file", args: { path: "out.txt", content: "x" }, note: "then write it" },
			],
			[
				{ tool: "list_dir", args: { path: "." } },
				{ tool: "write_file", args: { path: "out.txt", content: "x" } },
			],
		);

		expect(result.trace.steps).toHaveLength(2);
		expect(result.trace.steps[0]?.intent).toBe("look around first");
		expect(result.trace.steps[0]?.calls.map((call) => call.label.split(" ")[0])).toEqual(["list_dir"]);
		expect(result.trace.unattributed).toEqual([]);
	});

	it("keeps the call id, so a proposal and its result are one thing", async () => {
		const result = await runWith(
			[{ tool: "list_dir", args: { path: "." }, note: "look" }],
			[{ tool: "list_dir", args: { path: "." } }],
		);

		expect(result.trace.steps[0]?.calls[0]?.callId).toBe("c1");
	});
});

describe("a call the plan did not unambiguously name", () => {
	it("goes to `unattributed` when the plan never mentioned its tool", async () => {
		// The departure from the plan, which is exactly the run somebody is
		// investigating. Filing it under the nearest step would hide the departure while
		// looking complete.
		const result = await runWith(
			[{ tool: "list_dir", args: { path: "." }, note: "just look" }],
			[{ tool: "write_file", args: { path: "surprise.txt", content: "x" } }],
		);

		expect(result.trace.steps[0]?.calls).toEqual([]);
		expect(result.trace.unattributed.map((node) => node.label.split(" ")[0])).toContain("write_file");
	});

	it("goes to `unattributed` when TWO steps declared the same tool", async () => {
		// The ambiguity rule, and the reason this is a refusal rather than a guess.
		// Picking the earlier step would be a guess dressed as a fact, in a document
		// whose whole value is that it can be trusted.
		const result = await runWith(
			[
				{ tool: "write_file", args: { path: "a" }, note: "write the first" },
				{ tool: "write_file", args: { path: "b" }, note: "write the second" },
			],
			[{ tool: "write_file", args: { path: "a", content: "x" } }],
		);

		expect(result.trace.unattributed).toHaveLength(1);
		expect(result.trace.steps.every((step) => step.calls.length === 0)).toBe(true);
	});
});

describe("the attribution rule on its own", () => {
	it("names a tool exactly one step declared", () => {
		expect([...unambiguousSteps([{ tool: "a" }, { tool: "b" }])]).toEqual([
			["a", 1],
			["b", 2],
		]);
	});

	it("names nothing for a tool two steps declared", () => {
		expect([...unambiguousSteps([{ tool: "a" }, { tool: "a" }, { tool: "b" }])]).toEqual([["b", 3]]);
	});

	it("says nothing about an empty plan", () => {
		expect([...unambiguousSteps([])]).toEqual([]);
	});
});

describe("what a trace is for", () => {
	it("is uninteresting when everything went to plan", async () => {
		// A trace of a run that did what it said tells a reflecting persona nothing the
		// outcome does not already carry.
		const result = await runWith(
			[{ tool: "list_dir", args: { path: "." }, note: "look" }],
			[{ tool: "list_dir", args: { path: "." } }],
		);

		expect(traceIsInteresting(result.trace)).toBe(false);
	});

	it("is interesting the moment something happened outside the plan", async () => {
		const result = await runWith(
			[{ tool: "list_dir", args: { path: "." }, note: "look" }],
			[{ tool: "write_file", args: { path: "x.txt", content: "y" } }],
		);

		expect(traceIsInteresting(result.trace)).toBe(true);
	});

	it("reads as sentences, naming what fell outside the plan", async () => {
		const result = await runWith(
			[{ tool: "list_dir", args: { path: "." }, note: "look around" }],
			[{ tool: "write_file", args: { path: "x.txt", content: "y" } }],
		);
		const described = describeTrace(result.trace);

		expect(described).toContain("look around");
		expect(described).toContain("Not part of the plan");
	});
});

describe("a run with no plan at all", () => {
	it("still returns a trace, with everything unattributed", async () => {
		// The ordinary case: planning is opt-in. There are no intentions to read the
		// calls against, and saying so is more useful than an empty object.
		const agent = new PersonaAgent({
			llm: {
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: planningThen([], [{ tool: "list_dir", args: { path: "." } }]),
			},
			policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access" },
			capability: persona(),
			maxSteps: 3,
		});

		const result = await agent.run("no plan");

		expect(result.trace.steps).toEqual([]);
		expect(result.trace.unattributed.length).toBeGreaterThan(0);
	});
});
