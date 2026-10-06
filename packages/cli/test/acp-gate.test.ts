/**
 * The persona's policy answering an agent it drives, before the call runs.
 *
 * Against the REAL `enforcementHandler` and a real compiled policy, not a stand-in.
 * A mock here would prove that this file calls something, which was never in doubt;
 * what has to be true is that the same policy that refuses a call through the hook
 * refuses it through the protocol, in the same words.
 *
 * The measured reason it matters: `@agentclientprotocol/claude-agent-acp` drives
 * Claude Code with `settingSources: ["user"]` or `[]`, and our hook is written into
 * the PROJECT's settings. So an agent driven over ACP never runs the hook, and this
 * is the only thing standing between it and the tools.
 */

import { describe, expect, it } from "vitest";

import { argsTextOf, permissionFrom } from "../src/workspace/acp-gate.js";
import { enforcementHandler } from "../src/workspace/enforcement-service.js";
import type { EnforceRequest } from "../src/workspace/enforcement-endpoint.js";
import { PolicyCache } from "../src/workspace/policy-cache.js";

function policy(overrides: Record<string, unknown> = {}) {
	return {
		persona_version_id: "pv_1",
		hash: "h",
		compiled_at: new Date().toISOString(),
		ttl_seconds: 3600,
		deny: ["rm -rf"],
		allow: [],
		hard_limits: ["No unauthorized identity change."],
		prohibited_behaviors: [],
		egress_allowlist: [],
		sandbox: "workspace-write",
		approval: "never",
		gate_rules: [],
		...overrides,
	} as never;
}

/** The real gate, with a real policy in a real cache. */
function gate(options: { scope?: string[] } = {}) {
	const cache = new PolicyCache();
	cache.put(policy());
	return permissionFrom(
		enforcementHandler({
			cache,
			scope: options.scope ?? ["/work"],
			personaVersionFor: () => "pv_1",
		}),
	);
}

describe("a call the persona does not permit is refused before it runs", () => {
	it("refuses what the policy denies, and names the rule", async () => {
		const answer = await gate()("/work", { toolName: "Bash", rawInput: { command: "rm -rf /" } });

		expect(answer.allow).toBe(false);
		// A refusal a person cannot trace to a rule is one they work around rather
		// than understand.
		expect(String((answer as { reason: string }).reason).length).toBeGreaterThan(0);
	});

	it("allows what the policy does not deny", async () => {
		const answer = await gate()("/work", { toolName: "Read", rawInput: { file: "a.ts" } });
		expect(answer.allow).toBe(true);
	});

	it("the daemon's scope reaches this road too", async () => {
		// The consented directory is the daemon's boundary and it is not a property of
		// the transport. A call from outside it is refused here exactly as through the
		// hook, with the same word.
		const answer = await gate({ scope: ["/work"] })("/elsewhere", {
			toolName: "Bash",
			rawInput: { command: "ls" },
		});

		expect(answer.allow).toBe(false);
		expect(String((answer as { reason: string }).reason)).toContain("out_of_scope");
	});
});

describe("a gate that cannot answer", () => {
	it("refuses, rather than letting the agent act because the decider broke", async () => {
		// The one failure mode this product exists to make impossible: an agent
		// permitted by the absence of an answer.
		const decide = permissionFrom(async () => {
			throw new Error("the cache is gone");
		});

		const answer = await decide("/work", { toolName: "Bash", rawInput: {} });

		expect(answer.allow).toBe(false);
		expect(String((answer as { reason: string }).reason)).toContain("the cache is gone");
	});
});

describe("what the gate is actually shown", () => {
	function spy() {
		const seen: EnforceRequest[] = [];
		const decide = permissionFrom(async (request) => {
			seen.push(request);
			return { verdict: "allow" as const, rule: "", reason: "" };
		});
		return { decide, seen };
	}

	it("is the tool's name, because a policy is written about a tool", async () => {
		// The title is the sentence a person reads ("Reading a.ts"). Judging it gives
		// the gate a string no rule can match, so it refuses everything while looking
		// like it works: correct-shaped and inert.
		const { decide, seen } = spy();
		await decide("/work", { toolName: "Read", rawInput: {} });
		expect(seen[0]!.tool_name).toBe("Read");
	});

	it("carries the call id, so a verdict can be joined to what it judged", async () => {
		const { decide, seen } = spy();
		await decide("/work", { toolName: "Read", rawInput: {}, callId: "call_9" });
		expect(seen[0]!.tool_use_id).toBe("call_9");
	});

	it("omits the id rather than inventing one when the agent sent none", async () => {
		const { decide, seen } = spy();
		await decide("/work", { toolName: "Read", rawInput: {} });
		expect(seen[0]!.tool_use_id).toBeUndefined();
	});

	it("is the directory the daemon decided, not one the agent chose", async () => {
		const { decide, seen } = spy();
		await decide("/work/repo", { toolName: "Read", rawInput: {} });
		expect(seen[0]!.cwd).toBe("/work/repo");
	});
});

describe("the arguments, as text", () => {
	it("passes a string through", () => {
		expect(argsTextOf("ls -la")).toBe("ls -la");
	});

	it("serialises an object", () => {
		expect(argsTextOf({ command: "ls" })).toBe('{"command":"ls"}');
	});

	it("says nothing when there was nothing", () => {
		expect(argsTextOf(undefined)).toBe("");
		expect(argsTextOf(null)).toBe("");
	});

	it("is bounded, because a policy decides on what a call is and not on its payload", () => {
		// An unbounded argument would travel through every guard, into the gate event a
		// person reads, and into the record.
		expect(argsTextOf({ blob: "x".repeat(100_000) }).length).toBeLessThanOrEqual(4_000);
	});

	it("survives something that cannot be serialised, and still lets the call be judged", () => {
		const circular: Record<string, unknown> = {};
		circular["self"] = circular;
		// Judged on its name and its directory rather than refused for being
		// unprintable: an unserialisable argument is not evidence of anything.
		expect(argsTextOf(circular)).toBe("");
	});
});
