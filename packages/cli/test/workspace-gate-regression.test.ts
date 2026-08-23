/**
 * The hook denies exactly what it denied before, and costs what it cost before.
 *
 * Moving enforcement onto the shared cascade is the sort of change that is easy to
 * make and easy to make wrong, because everything still compiles and the obvious tests
 * still pass while a rule string quietly changes and somebody's runbook stops matching
 * what they see. So this file checks the two things a refactor of a gate has to prove:
 * the same calls get the same answers with the same words, and the decision is still
 * fast enough that nobody turns it off.
 *
 * The second one is not a nicety. The measured budget is 150 ms and the hook decision
 * sits at roughly a microsecond, so there is enormous headroom, and the reason to
 * assert it anyway is that the headroom is exactly what invites somebody to put a file
 * read or a network call in a guard. This fails long before a person would notice.
 */

import { describe, expect, it } from "vitest";

import { gate } from "@personaxis/core";

import { PolicyCache } from "../src/workspace/policy-cache.js";
import { enforcementHandler } from "../src/workspace/enforcement-service.js";

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

function handler(extra: Record<string, unknown> = {}) {
	const cache = new PolicyCache();
	cache.put(policy((extra.policy as Record<string, unknown>) ?? {}));
	return enforcementHandler({
		cache,
		personaVersionFor: () => "pv_1",
		...(extra.deps as Record<string, unknown>),
	} as never);
}

describe("the words a refusal uses have not moved", () => {
	it("still names out_of_scope, and still tells the operator the flag to use", async () => {
		const handle = enforcementHandler({
			cache: new PolicyCache(),
			personaVersionFor: () => null,
		});

		const reply = await handle({ tool_name: "Bash", args_text: "ls", cwd: "/elsewhere" });

		expect(reply.verdict).toBe("deny");
		expect(reply.rule).toBe("out_of_scope");
		expect(reply.reason).toContain("connect --dir");
	});

	it("still names the deny pattern that matched", async () => {
		const reply = await handler()({ tool_name: "Bash", args_text: "rm -rf /", cwd: "/work" });

		expect(reply.verdict).toBe("deny");
		expect(reply.rule).toBe("deny:rm -rf");
	});

	it("still names the hard limit that matched, by index", async () => {
		const reply = await handler()({
			tool_name: "Bash",
			args_text: "perform an unauthorized identity change",
			cwd: "/work",
		});

		expect(reply.verdict).toBe("deny");
		expect(reply.rule).toBe("hard_limit:0");
	});

	it("still carries the policy's own rule on an allow, rather than a flattened word", async () => {
		// `approval:never` is what the reply used to say and something downstream shows
		// it. A refactor that replaced it with a bare "allow" would take information off
		// a screen without anybody deciding to.
		const reply = await handler()({ tool_name: "Read", args_text: "README", cwd: "/work" });

		expect(reply.verdict).toBe("allow");
		expect(reply.rule).toBe("approval:never");
	});

	it("still refuses a gated call it cannot ask about, in the same words", async () => {
		const reply = await handler({
			policy: {
				approval: "on-request",
				gate_rules: [
					{ action_class: "file_delete", required_approvals: 1, route: {}, timeout_seconds: 600 },
				],
			},
		})({ tool_name: "Bash", args_text: "delete the archive", cwd: "/work" });

		expect(reply.verdict).toBe("deny");
		expect(reply.reason).toContain("cannot reach the workspace");
	});
});

describe("what the cascade added, and could not have added before", () => {
	it("reports both reasons when two guards refuse, not just the first", async () => {
		// The old chain returned at the first refusal. Somebody who widened one scope,
		// found the call still refused and had no hint why concluded that enforcement
		// was broken.
		const extra: gate.Guard = {
			name: "extra",
			check: () => gate.deny("machine_paused", "this machine is paused by its operator"),
		};

		const reply = await handler({ deps: { guards: [extra] } })({
			tool_name: "Bash",
			args_text: "rm -rf /",
			cwd: "/work",
		});

		expect(reply.reason).toContain("deny");
		expect(reply.reason).toContain("paused");
	});

	it("lets a mounted guard refuse something the policy would have allowed", async () => {
		const extra: gate.Guard = {
			name: "identity",
			check: () => gate.deny("envelope:honesty", "this would leave the declared envelope"),
		};

		const reply = await handler({ deps: { guards: [extra] } })({
			tool_name: "Read",
			args_text: "README",
			cwd: "/work",
		});

		expect(reply.verdict).toBe("deny");
		expect(reply.rule).toBe("envelope:honesty");
	});

	it("cannot be loosened by a mounted guard, whatever it returns", async () => {
		// The type has no allow case, so this is a formality. It is here because the
		// guarantee is the reason the daemon may accept guards from a deployment at all.
		const optimistic: gate.Guard = { name: "optimistic", check: () => undefined };

		const reply = await handler({ deps: { guards: [optimistic] } })({
			tool_name: "Bash",
			args_text: "rm -rf /",
			cwd: "/work",
		});

		expect(reply.verdict).toBe("deny");
	});
});

describe("the decision still costs what it cost", () => {
	it("stays far inside the budget over twenty thousand calls", async () => {
		// The number that matters is p95, and the headroom is what invites somebody to
		// put a file read in a guard. This fails long before a person would notice.
		const handle = handler();
		const samples: number[] = [];

		for (let index = 0; index < 20_000; index += 1) {
			const started = performance.now();
			await handle({ tool_name: "Read", args_text: `file-${index}`, cwd: "/work" });
			samples.push(performance.now() - started);
		}

		samples.sort((left, right) => left - right);
		const p95 = samples[Math.floor(samples.length * 0.95)]!;

		expect(p95).toBeLessThan(1);
	});
});
