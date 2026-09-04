/**
 * The loop breaker: its nudge signed, and its stop measured to be unmountable.
 *
 * It was already right about the escalation: notice a repetition, nudge once, stop if
 * it carries on. E10 set out to give both halves a place, and got one of them.
 *
 * **The nudge is mounted, and it now carries its author.** A message injected into a
 * transcript with no label renders as a real request from the person, which is the
 * fourth independent sighting of that rule in this repository. It also produces
 * something to ADD and never a verdict and never a rewrite: the reference's own trap
 * is an advisory guard that patched a tool result, which makes the logged result lie
 * about what the tool returned.
 *
 * **The stop is not, and the reason is measured rather than argued.** A stop is a
 * refusal and belongs in a cascade in principle. In this loop it cannot get there: the
 * breaker is assessed once per step, after the calls have run, and the loop returns
 * immediately on a stop, so by the time there is another call to refuse the run is
 * over. `breakerGuard` was wired in, passed every test, and refused nothing. It came
 * back out, because a guard that sits in the list and never fires is worse than an
 * absent one: it reads as covered.
 *
 * The fourth test below is that measurement, kept as an assertion so the day somebody
 * makes the guard reachable, this file says so by going red.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	DEFAULT_POLICY,
	PersonaAgent,
	compile,
	type ChatMessage,
	type CompiledPolicy,
	type LoopEvent,
} from "../src/index.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-breaker-"));
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

/**
 * A model that proposes the SAME failing call forever.
 *
 * Which is the loop worth breaking, and the reason the breaker is consulted after
 * execution rather than before: a model hammering a call the gate keeps denying is
 * exactly this shape, and a breaker that only saw successful calls would never see it.
 */
function repeating(): typeof fetch {
	let seen = 0;
	return (async (url: string) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		seen += 1;
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
									id: `c${seen}`,
									type: "function",
									// A path the persona forbids, so every step is refused identically.
									function: { name: "read_file", arguments: '{"path":"forbidden.txt"}' },
								},
							],
						},
					},
				],
			}),
		};
	}) as unknown as typeof fetch;
}

async function runRepeating(maxSteps = 12) {
	const events: LoopEvent[] = [];
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl: repeating() },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access" },
		// Denied, every time, which is the canonical case the breaker header names: a
		// model hammering a call the gate keeps refusing. Written first as a read of a
		// file that does not exist, and that never triggered anything, because a failed
		// READ still counts as work done: the run reached max_steps instead.
		capability: persona({ deny: ["forbidden"] }),
		maxSteps,
	});
	agent.bus.on((event) => events.push(event));
	const result = await agent.run("keep trying the same thing");
	return { result, events, messages: agent.lastMessages ?? ([] as ChatMessage[]) };
}

describe("a run that repeats without getting anywhere", () => {
	it("gets a nudge before it gets a stop", async () => {
		// The escalation, which was already right. One hint to change approach comes
		// first; stopping is what happens if it carries on.
		const { messages } = await runRepeating();

		const nudges = messages.filter((message) => message.content.includes("Loop check"));
		expect(nudges.length).toBeGreaterThan(0);
	});

	it("signs the nudge with the runtime that added it", async () => {
		// Unlabelled, it renders as something the person said. The loop-breaker is the
		// runtime doing something nobody asked for, and it says which mechanism and why.
		const { messages } = await runRepeating();
		const nudge = messages.find((message) => message.content.includes("Loop check"));

		expect(nudge?.content).toContain("runtime:loop-breaker");
	});

	it("stops, and says the breaker stopped it", async () => {
		const { result, events } = await runRepeating();

		expect(result.finished).toBe(false);
		expect(result.budget.stoppedBy).toBe("loop_breaker");
		expect(events.some((event) => event.type === "agent-stop-condition")).toBe(true);
	});

	it("stops the repetition INSIDE a step, once several calls arrive at once", async () => {
		// What E22 bought, and the only shape that shows it.
		//
		// The breaker is recorded per CALL now, so the fourth identical refused call in
		// one step meets a cascade that already knows about the first three. Before, the
		// breaker was recorded once per step, so a model proposing six identical calls in
		// a single message got all six run and refused, and the stop arrived afterwards.
		//
		// With one call per step the two are the same sequence, which is why every other
		// test in this file still passes unchanged.
		const events: LoopEvent[] = [];
		const agent = new PersonaAgent({
			llm: {
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: (async (url: string) => {
					if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
					return {
						ok: true,
						status: 200,
						headers: new Headers({ "content-type": "application/json" }),
						json: async () => ({
							choices: [
								{
									message: {
										content: "",
										// Six identical refused calls, in ONE message.
										tool_calls: Array.from({ length: 6 }, (_, index) => ({
											id: `c${index}`,
											type: "function",
											function: { name: "read_file", arguments: '{"path":"forbidden.txt"}' },
										})),
									},
								},
							],
						}),
					};
				}) as unknown as typeof fetch,
			},
			policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access" },
			capability: persona({ deny: ["forbidden"] }),
			maxSteps: 2,
		});
		agent.bus.on((event) => events.push(event));

		await agent.run("try it six times at once");

		const verdicts = events.filter((event) => event.type === "tool-verdict") as Array<{ reason: string }>;
		expect(
			verdicts.some((verdict) => /repeated the same failing action|no progress in/.test(verdict.reason)),
			"the breaker should have refused one of the later calls in the same step",
		).toBe(true);
	});

	it("stops a STALL inside a step, when the calls differ but none get anywhere", async () => {
		// The other branch of the breaker, and the one `producedWork` decides. Repetition
		// is recognised by an identical failing signature; a stall is recognised by a
		// stretch with no progress whatever the calls were. Seven different refused paths
		// in one step is a stall and not a repetition.
		//
		// Two controls needed this: `producedWork: true` and `producedWork: false` both
		// left every other test in this file green, because repetition only reads the
		// signature and nothing here ran long enough to stall.
		const events: LoopEvent[] = [];
		const agent = new PersonaAgent({
			llm: {
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: (async (url: string) => {
					if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
					return {
						ok: true,
						status: 200,
						headers: new Headers({ "content-type": "application/json" }),
						json: async () => ({
							choices: [
								{
									message: {
										content: "",
										tool_calls: Array.from({ length: 7 }, (_, index) => ({
											id: `c${index}`,
											type: "function",
											// A DIFFERENT forbidden path each time, so no two share a signature.
											function: { name: "read_file", arguments: `{"path":"forbidden-${index}.txt"}` },
										})),
									},
								},
							],
						}),
					};
				}) as unknown as typeof fetch,
			},
			policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access" },
			capability: persona({ deny: ["forbidden"] }),
			maxSteps: 2,
		});
		agent.bus.on((event) => events.push(event));

		await agent.run("try seven different things at once");

		const verdicts = events.filter((event) => event.type === "tool-verdict") as Array<{ reason: string }>;
		expect(verdicts.some((verdict) => /no progress in/.test(verdict.reason))).toBe(true);
	});

	it("does not stop a long run that IS getting somewhere", async () => {
		// The control on the other side, and it has to be long: a healthy run of two or
		// three calls never approaches the stall threshold, so a breaker that counted
		// every call as failing would pass a short test and interrupt real work.
		const events: LoopEvent[] = [];
		const agent = new PersonaAgent({
			llm: {
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: (async (url: string) => {
					if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
					return {
						ok: true,
						status: 200,
						headers: new Headers({ "content-type": "application/json" }),
						json: async () => ({
							choices: [
								{
									message: {
										content: "",
										tool_calls: Array.from({ length: 8 }, (_, index) => ({
											id: `ok${index}`,
											type: "function",
											function: { name: "list_dir", arguments: '{"path":"."}' },
										})),
									},
								},
							],
						}),
					};
				}) as unknown as typeof fetch,
			},
			policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access" },
			capability: persona(),
			maxSteps: 2,
		});
		agent.bus.on((event) => events.push(event));

		await agent.run("do eight useful things at once");

		const verdicts = events.filter((event) => event.type === "tool-verdict") as Array<{ reason: string }>;
		expect(
			verdicts.some((verdict) => /repeated the same failing action|no progress in/.test(verdict.reason)),
		).toBe(false);
	});

	it("does not reach the cascade when each step holds a single call", async () => {
		// The other half of E22, and the reason it was worth asking before doing it.
		//
		// When a step holds ONE call, recording per call and recording per step are the
		// same sequence: the loop still returns the moment the breaker says stop, so the
		// guard has nothing left to refuse. Nothing about this shape changed, which is
		// what keeps the escalation people already know from moving under them.
		//
		// Asserted on the breaker's OWN words rather than on a bare `deny`, which is
		// what made all of this visible: written the loose way, the mutation that removed
		// the guard stayed green, because the persona's policy denies every one of these
		// calls anyway.
		const { events } = await runRepeating();
		const verdicts = events.filter((event) => event.type === "tool-verdict") as Array<{
			decision: string;
			reason: string;
		}>;

		expect(
			verdicts.some((verdict) => /repeated the same failing action|no progress in/.test(verdict.reason)),
		).toBe(false);
	});
});

describe("a run that is getting somewhere", () => {
	it("is never nudged or stopped", async () => {
		// The control. A breaker that fired on a healthy run would be worse than none:
		// it would interrupt work that was going fine, and people would turn it off.
		const events: LoopEvent[] = [];
		let seen = 0;
		const agent = new PersonaAgent({
			llm: {
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: (async (url: string) => {
					if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
					seen += 1;
					const call =
						seen >= 3
							? { name: "finish", arguments: '{"summary":"done"}' }
							: { name: "list_dir", arguments: '{"path":"."}' };
					return {
						ok: true,
						status: 200,
						headers: new Headers({ "content-type": "application/json" }),
						json: async () => ({
							choices: [{ message: { content: "", tool_calls: [{ id: `c${seen}`, type: "function", function: call }] } }],
						}),
					};
				}) as unknown as typeof fetch,
			},
			policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access" },
			capability: persona(),
			maxSteps: 6,
		});
		agent.bus.on((event) => events.push(event));

		const result = await agent.run("do three useful things");

		expect(result.budget.stoppedBy).not.toBe("loop_breaker");
		expect(agent.lastMessages?.some((message) => message.content.includes("Loop check"))).toBeFalsy();
	});
});
