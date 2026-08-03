// The planning phase: asking for a plan and acting on the verdict.
//
// `decidePlan` was already tested. What was never tested is what a run does with it, because
// nothing called it. These are about the loop: how many times it asks, what it sends back,
// and what happens when the model never produces a runnable plan.

import { describe, expect, it, vi } from "vitest";

import { runPlanPhase } from "../src/plan-run.js";
import type { Policy } from "../src/sandbox.js";
import type { ToolSpec } from "../src/tools/registry.js";

/** A tool whose gate always returns the same verdict. Enough: the gate itself is tested. */
function tool(name: string, decision: "allow" | "ask" | "deny"): ToolSpec {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		gate: () => ({
			decision,
			reason: `${name} is ${decision}`,
			class: { kind: "read", destructive: false, network: false } as never,
		}),
		execute: async () => ({ ok: true, output: "" }) as never,
	} as unknown as ToolSpec;
}

const tools: ToolSpec[] = [tool("read_file", "allow"), tool("run_command", "deny")];

const policy = {} as unknown as Policy;

const plan = (steps: Array<{ tool: string; why: string }>) => JSON.stringify(steps);

function deps(replies: string[], overrides: Partial<Parameters<typeof runPlanPhase>[1]> = {}) {
	const asked: number[] = [];
	const ask = vi.fn(async (messages) => {
		asked.push(messages.length);
		return replies[Math.min(asked.length - 1, replies.length - 1)];
	});
	return { ask, asked, deps: { ask, tools, policy, ...overrides } };
}

describe("a plan that can run", () => {
	it("returns the anchor for the conversation", async () => {
		const { deps: d } = deps([plan([{ tool: "read_file", why: "look at the brief" }])]);
		const result = await runPlanPhase([{ role: "user", content: "summarise" }], d);

		expect(result.ok).toBe(true);
		expect(result.ok && result.anchor).toBeTruthy();
		expect(result.ok && result.steps).toHaveLength(1);
	});

	it("asks once when the first plan is fine", async () => {
		const { deps: d, ask } = deps([plan([{ tool: "read_file", why: "x" }])]);
		await runPlanPhase([], d);

		expect(ask).toHaveBeenCalledTimes(1);
	});

	it("never mutates the conversation it was given", async () => {
		// The caller decides what a rejected plan leaves in the record. Appending to their
		// array would make that decision for them, invisibly.
		const conversation = [{ role: "user" as const, content: "go" }];
		const { deps: d } = deps([plan([{ tool: "read_file", why: "x" }])]);

		await runPlanPhase(conversation, d);
		expect(conversation).toHaveLength(1);
	});
});

describe("a plan that cannot run", () => {
	it("asks again after a refusal", async () => {
		const { deps: d, ask } = deps([
			plan([{ tool: "run_command", why: "delete the thing" }]),
			plan([{ tool: "read_file", why: "read it instead" }]),
		]);

		const result = await runPlanPhase([], d);

		expect(ask).toHaveBeenCalledTimes(2);
		expect(result.ok).toBe(true);
		expect(result.ok && result.attempts).toBe(2);
	});

	it("sends back the refused plan AND the reason", async () => {
		// Sending only the reason loses what it was a reason about, and the next plan repeats
		// the refused step because nothing in the context says which one it was.
		const refused = plan([{ tool: "run_command", why: "wipe" }]);
		const { deps: d, ask } = deps([refused, plan([{ tool: "read_file", why: "ok" }])]);

		await runPlanPhase([], d);

		const second = ask.mock.calls[1][0] as Array<{ role: string; content: string }>;
		expect(second.some((m) => m.role === "assistant" && m.content === refused)).toBe(true);
		expect(second.some((m) => m.role === "system" && m.content.includes("run_command"))).toBe(true);
	});

	it("stops the run when no plan survives", async () => {
		// Proceeding anyway is the worst option available: it spends the planning turn, tells
		// the operator the plan was refused, and does the work regardless, which teaches
		// everybody that the gate is decorative.
		const { deps: d } = deps([plan([{ tool: "run_command", why: "still no" }])]);
		const result = await runPlanPhase([], d);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain("run_command");
	});

	it("bounds how many times it asks", async () => {
		const { deps: d, ask } = deps([plan([{ tool: "run_command", why: "no" }])]);
		await runPlanPhase([], d, { maxAttempts: 3 });

		expect(ask).toHaveBeenCalledTimes(3);
	});

	it("always asks at least once", async () => {
		// A misconfigured zero would skip planning entirely while reporting that it happened.
		const { deps: d, ask } = deps([plan([{ tool: "read_file", why: "x" }])]);
		await runPlanPhase([], d, { maxAttempts: 0 });

		expect(ask).toHaveBeenCalledTimes(1);
	});
});

describe("a reply that is not a plan", () => {
	it("asks again rather than dying", async () => {
		// A model asked for JSON returns prose often enough that a parser which throws turns a
		// recoverable formatting slip into a dead run.
		const { deps: d } = deps(["Sure! Here is my plan:", plan([{ tool: "read_file", why: "x" }])]);
		const result = await runPlanPhase([], d);

		expect(result.ok).toBe(true);
	});

	it("gives up with a reason a person can read", async () => {
		const { deps: d } = deps(["not json at all"]);
		const result = await runPlanPhase([], d, { maxAttempts: 1 });

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toMatch(/could not be read|no plan/i);
	});
});

describe("reporting", () => {
	it("reports every outcome, not only the last", async () => {
		// The refused attempt is the interesting one for whoever reads the transcript.
		const outcomes: string[] = [];
		const { deps: d } = deps(
			[plan([{ tool: "run_command", why: "no" }]), plan([{ tool: "read_file", why: "yes" }])],
			{ onOutcome: (outcome) => outcomes.push(outcome.kind) },
		);

		await runPlanPhase([], d);
		expect(outcomes).toEqual(["rejected", "proceed"]);
	});
});
