/**
 * Where data goes, decided before anything else about a call.
 *
 * The allowlist and its verdict have been in `enforcement/egress.ts` since the third
 * phase, and `evaluate` has consulted them since. What changed underneath them is that
 * `evaluate` now runs in OUR loop: before E2 the persona's compiled policy governed a
 * Claude Code or a Codex driven through the daemon and governed nothing here. So the
 * egress rule was enforced on other people's agents and not on the one this product
 * ships, and nothing said so.
 *
 * This file is that gap closed and, more usefully, pinned. The rule it protects is the
 * one worth restating: absence is denial. A persona with an empty allowlist reaches
 * nothing, because that is the only default that makes a new connector safe before
 * anybody has thought about which hosts it needs.
 *
 * ## What this does NOT cover, and it is the larger half
 *
 * This is a policy check over what a call SAYS it will do. It reads a command line and
 * finds the URLs in it. A process that resolves a host at runtime, or opens a socket
 * from inside a script, is not visible to it, and no amount of pattern work would make
 * it so. Denying egress for real needs the network denied around the process, which is
 * a sandbox property rather than a policy one, and that is the other half of E15.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	DEFAULT_POLICY,
	PersonaAgent,
	checkEgress,
	compile,
	urlsIn,
	type CompiledPolicy,
	type LoopEvent,
} from "../src/index.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-egress-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function persona(egress: string[]): ReturnType<typeof compile> {
	const policy: CompiledPolicy = {
		persona_version_id: "pv",
		hash: "h",
		compiled_at: new Date().toISOString(),
		ttl_seconds: 3600,
		deny: [],
		allow: [],
		hard_limits: [],
		prohibited_behaviors: [],
		egress_allowlist: egress,
		sandbox: "danger-full-access",
		approval: "never",
		gate_rules: [],
	};
	return compile(policy);
}

/**
 * Runs one command through the loop and returns the verdict it got.
 *
 * The commands are `echo`, not `curl`, and that is not laziness. The egress rule reads
 * the URLs out of the command TEXT and decides before anything runs, so `echo` gets the
 * identical verdict. Written with `curl` at first, the allowed case took 447ms because
 * it really did reach github.com: a suite that makes network calls is a suite that
 * fails on a train.
 */
async function verdictFor(command: string, egress: string[]) {
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
					seen === 1
						? { name: "run_command", arguments: JSON.stringify({ command }) }
						: { name: "finish", arguments: '{"summary":"done"}' };
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
		capability: persona(egress),
		maxSteps: 3,
	});
	agent.bus.on((event) => events.push(event));
	await agent.run("do it");
	return (events.find((event) => event.type === "tool-verdict") ?? undefined) as
		| { decision: string; reason: string }
		| undefined;
}

describe("a persona reaching out of the machine", () => {
	it("is refused when it declared no allowlist at all", async () => {
		// Absence is denial. The only default that makes a new connector safe before
		// anybody has thought about which hosts it needs.
		const verdict = await verdictFor("echo https://example.com/collect", []);

		expect(verdict?.decision).toBe("deny");
		expect(verdict?.reason).toContain("no egress allowlist");
	});

	it("is allowed to reach a host it declared", async () => {
		// The control. A rule that refused every command would pass the test above and
		// leave the persona unable to do its job.
		const verdict = await verdictFor("echo https://api.github.com/repos", ["api.github.com"]);

		expect(verdict?.decision).toBe("allow");
	});

	it("is refused for a host it did not declare, even holding others", async () => {
		// The case the rule is actually for: a persona with a legitimate connector,
		// talked by an injected instruction into posting somewhere else.
		const verdict = await verdictFor("echo https://evil.example/collect", ["api.github.com"]);

		expect(verdict?.decision).toBe("deny");
	});

	it("does not judge a command that reaches nowhere", async () => {
		const verdict = await verdictFor("echo hello", []);

		expect(verdict?.decision).toBe("allow");
	});
});

describe("the matching itself, where a near miss is the attack", () => {
	it("refuses a host that merely contains an allowed one", () => {
		// `evil-googleapis.com` and `googleapis.com.attacker.example` both read as the
		// real thing at a glance, and a substring check would admit both.
		expect(checkEgress("https://evil-googleapis.com/x", ["googleapis.com"]).allowed).toBe(false);
		expect(checkEgress("https://googleapis.com.attacker.example/x", ["googleapis.com"]).allowed).toBe(
			false,
		);
	});

	it("allows a subdomain of an allowed host", () => {
		// The control on the other side. Refusing subdomains would make the list
		// unusable for every real API.
		expect(checkEgress("https://storage.googleapis.com/x", ["googleapis.com"]).allowed).toBe(true);
	});

	it("finds the URLs in a command line", () => {
		expect(urlsIn("curl -X POST https://a.example/x && wget http://b.example")).toEqual([
			"https://a.example/x",
			"http://b.example",
		]);
	});
});
