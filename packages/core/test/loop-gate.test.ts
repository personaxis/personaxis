/**
 * The persona's own limits govern the loop this product ships.
 *
 * Until E2 they did not, and the shape of the gap is worth stating because it is the
 * opposite of what anyone would assume. A Claude Code or a Codex driven through the
 * daemon was judged against the persona's compiled policy: its `deny` patterns, its
 * hard limits, its prohibited behaviours, its sandbox posture. The loop we wrote was
 * not. It asked `tool.gate`, which knows about the workspace root and the OS sandbox
 * and has never heard of the persona.
 *
 * Measured on 2026-09-04: `gate/waterfall.ts` had exactly one caller in the whole
 * repository, `enforcement-service.ts`. The two-axis gate ran for other people's
 * agents and not for ours.
 *
 * So these tests are about one question: does a limit written in a persona document
 * stop a call inside `PersonaAgent`. Each is paired with the call that must still
 * run, because a loop that refuses everything is not enforcement, it is a broken
 * loop, and it passes every test that only checks for denials.
 */

import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	compile,
	DEFAULT_POLICY,
	PersonaAgent,
	type CompiledPolicy,
	run,
	type LoopEvent,
	type Policy,
} from "../src/index.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-loop-gate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function environment(over: Partial<Policy> = {}): Policy {
	return { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access", ...over };
}

/** A persona's compiled limits, as the daemon would hold them. */
function persona(over: Partial<CompiledPolicy> = {}) {
	return compile({
		persona_version_id: "pv_test",
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

/** A model that proposes exactly these calls and then stops. */
function scripted(steps: Array<{ tool: string; args: object }>): typeof fetch {
	let index = 0;
	return (async (url: string) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		const step = steps[Math.min(index, steps.length - 1)];
		index += 1;
		return {
			ok: true,
			status: 200,
			json: async () => ({
				choices: [
					{
						message: {
							content: "",
							tool_calls: [
								{
									id: `c${index}`,
									type: "function",
									function: { name: step!.tool, arguments: JSON.stringify(step!.args) },
								},
							],
						},
					},
				],
			}),
		};
	}) as unknown as typeof fetch;
}

/** Runs one proposed call and hands back what the gate said about it. */
async function verdictFor(
	call: { tool: string; args: object },
	options: { capability?: ReturnType<typeof persona>; policy?: Policy } = {},
) {
	const events: LoopEvent[] = [];
	const agent = new PersonaAgent({
		llm: {
			endpoint: "http://x/v1",
			model: "m",
			fetchImpl: scripted([call, { tool: "finish", args: { summary: "done" } }]),
		},
		policy: options.policy ?? environment(),
		...(options.capability ? { capability: options.capability } : {}),
	});
	agent.bus.on((event) => events.push(event));
	await agent.run("do it");
	return events.find((event) => event.type === "tool-verdict") as
		| { type: "tool-verdict"; tool: string; decision: string; reason: string }
		| undefined;
}

describe("a limit written in the persona document", () => {
	it("stops the call inside our own loop, naming the rule that stopped it", async () => {
		// The whole of E2 in one assertion. `deny` is the persona's, not the
		// environment's, and before this it was enforced on every agent except ours.
		const verdict = await verdictFor(
			{ tool: "run_command", args: { command: "curl https://example.com" } },
			{ capability: persona({ deny: ["curl"] }) },
		);

		expect(verdict?.decision).toBe("deny");
		expect(verdict?.reason).toContain("curl");
	});

	it("lets the same call run when the persona did not forbid it", async () => {
		// The control that makes the test above mean something. Without it, a loop that
		// refused every command would pass it.
		const verdict = await verdictFor(
			{ tool: "list_dir", args: { path: "." } },
			{ capability: persona() },
		);

		expect(verdict?.decision).toBe("allow");
	});

	it("enforces a hard limit written for a person, not just a pattern", async () => {
		// The limits a persona declares are prose, reduced to keywords at compile time.
		// This is the shape of limit somebody actually writes, and until E2 it governed
		// other people's agents and not the one we ship.
		const verdict = await verdictFor(
			{ tool: "run_command", args: { command: "git push origin main" } },
			// Every keyword has to appear, which is what keeps one careless line in a
			// persona from becoming a policy that refuses everything. Written first as
			// "Never push to a shared branch", which reduces to push/shared/branch and
			// matched nothing: the limit was fine, the sentence just did not describe
			// the command.
			{ capability: persona({ hard_limits: ["Never push to main."] }) },
		);

		expect(verdict?.decision).toBe("deny");
	});
});

describe("a run with no compiled policy", () => {
	it("refuses by name, rather than falling through to the tool's own gate", async () => {
		// The verification E2 was written against: an execution with no policy is a
		// denial with a name in the list of guards, not a special case in a loop. The
		// waterfall with no guards ALLOWS, so this had to be a registered guard rather
		// than an absence.
		const verdict = await verdictFor({ tool: "list_dir", args: { path: "." } });

		expect(verdict?.decision).toBe("deny");
		expect(verdict?.reason).toContain("no compiled policy");
	});

	it("does not write the file it was asked to write", async () => {
		// The refusal is real rather than cosmetic. A verdict event saying deny while
		// the effect happened anyway is the worst of both.
		await verdictFor({ tool: "write_file", args: { path: "leak.txt", content: "x" } });

		expect(existsSync(join(dir, "leak.txt"))).toBe(false);
	});
});

describe("the tool's own gate, now one voice among several", () => {
	it("still refuses what only it can see", async () => {
		// The environment's own deny list, which the persona's policy knows nothing
		// about: an operator can forbid something on this machine without editing
		// anybody's persona.
		//
		// The command is deliberately harmless. Written first as a write that escaped
		// the workspace root, and removing the tool guard did NOT make that test fail:
		// `tightenVerdict` is handed the tool's CLASS, so an escaping or destructive
		// call is caught a second time by the consent matrix whatever the cascade said.
		// That is defence in depth working, and it is also a test proving something
		// other than its name. An `echo` carries no risky class at all, so the tool
		// gate's verdict is the only thing that can refuse it.
		const verdict = await verdictFor(
			{ tool: "run_command", args: { command: "echo hello" } },
			{ capability: persona(), policy: environment({ deny: ["echo"] }) },
		);

		expect(verdict?.decision).toBe("deny");
	});

	it("cannot rescue a call the persona's policy refused", async () => {
		// The property the cascade exists for, and the reason the tool gate is
		// translated one-way: a guard has no allow case, so a permissive tool verdict
		// cannot lift a denial from another guard, whatever order they run in.
		const verdict = await verdictFor(
			{ tool: "list_dir", args: { path: "." } },
			{ capability: persona({ deny: ["list_dir", "\\."] }) },
		);

		expect(verdict?.decision).toBe("deny");
	});
});

describe("where the loop gets the persona's limits from", () => {
	it("derives them from the frontmatter, beside the budget", async () => {
		// Not from the caller. A caller that could pass this would be changing the
		// persona without editing it, which is the argument `runner-for.ts` already
		// makes about the budget and the verification block.
		const options = run.agentOptionsFor({
			personaPath: join(dir, "PERSONA.md"),
			frontmatter: { permissions: { deny: ["rm -rf"] } },
			llm: { endpoint: "http://x/v1", model: "m" },
		});

		expect(options.capability).toBeDefined();
		expect(options.capability?.policy.deny).toEqual(["rm -rf"]);
	});

	it("produces a policy even for a persona that declares no permissions", async () => {
		// The empty document is the common case for a young persona, and it has to
		// yield a policy rather than nothing: `undefined` would mean every call refused
		// for a persona whose author simply had not written a limit yet.
		const options = run.agentOptionsFor({
			personaPath: join(dir, "PERSONA.md"),
			frontmatter: {},
			llm: { endpoint: "http://x/v1", model: "m" },
		});

		expect(options.capability).toBeDefined();
	});
});
