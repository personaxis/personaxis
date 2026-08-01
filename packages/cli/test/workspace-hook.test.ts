/**
 * The enforcement path, from the host's payload to the verdict.
 *
 * Every test here is about a way the answer could be wrong in the permissive
 * direction, because that is the only direction that matters: a refusal that
 * should have been an allow costs someone a retry, and an allow that should
 * have been a refusal is the product not working.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompiledPolicy } from "@personaxis/core";
import { hashPolicy, policyFromPersona } from "@personaxis/core";

import { enforcementHandler } from "../src/workspace/enforcement-service.js";
import { argsTextFor, failClosed, hookResponseFor, parseHookInput } from "../src/workspace/hook-protocol.js";
import { claudeCodeAdapter, HOOK_MARKER } from "../src/workspace/host-adapter.js";
import { PolicyCache } from "../src/workspace/policy-cache.js";

function policy(overrides: Partial<CompiledPolicy> = {}): CompiledPolicy {
	const draft = {
		persona_version_id: "pv_1",
		compiled_at: new Date().toISOString(),
		ttl_seconds: 3600,
		deny: [] as string[],
		allow: [] as string[],
		hard_limits: [] as string[],
		prohibited_behaviors: [] as string[],
		sandbox: "danger-full-access" as const,
		approval: "never" as const,
		gate_rules: [],
		...overrides,
	};
	return { ...draft, hash: hashPolicy(draft) };
}

describe("reading what the host sends", () => {
	it("reads the documented payload", () => {
		const input = parseHookInput(
			JSON.stringify({
				session_id: "abc",
				cwd: "/work/repo",
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "rm -rf /tmp/build" },
				tool_use_id: "toolu_1",
			}),
		);
		expect(input?.tool_name).toBe("Bash");
		expect(input?.tool_use_id).toBe("toolu_1");
	});

	it("returns null instead of throwing on anything else", () => {
		// A hook that crashed would exit non-zero with a stack trace, which the
		// host reads as a non-blocking error: the call would run.
		expect(parseHookInput("not json")).toBeNull();
		expect(parseHookInput("[]")).toBeNull();
		expect(parseHookInput("")).toBeNull();
	});

	it("puts the argument values in the text a policy matches", () => {
		// A policy that could only see the key names could not deny anything
		// worth denying.
		const text = argsTextFor({ command: "rm -rf /" });
		expect(text).toContain("rm -rf /");
	});

	it("is stable, so the same call always reads the same", () => {
		const a = argsTextFor({ b: 2, a: 1, nested: { z: 1, y: 2 } });
		const b = argsTextFor({ a: 1, nested: { y: 2, z: 1 }, b: 2 });
		expect(a).toBe(b);
	});
});

describe("answering in the host's contract", () => {
	it("allows with exit 0 and the documented decision", () => {
		const response = hookResponseFor({ verdict: "allow", rule: "approval:never" });
		expect(response.exitCode).toBe(0);
		expect(JSON.parse(response.stdout).hookSpecificOutput).toMatchObject({
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
		});
	});

	it("puts the reason for a refusal on stderr, not only in the JSON", () => {
		// The host IGNORES stdout on exit 2 and shows stderr. A refusal whose
		// reason went only to the ignored channel is a refusal nobody can act on.
		const response = hookResponseFor({
			verdict: "deny",
			rule: "deny:rm -rf",
			reason: "permissions.deny matched: rm -rf",
		});
		expect(response.exitCode).toBe(2);
		expect(response.stderr).toContain("permissions.deny matched: rm -rf");
		expect(response.stderr).toContain("deny:rm -rf");
	});

	it("refuses rather than escalating when it cannot check", () => {
		// `ask` would put the question in front of whoever is at the keyboard.
		// The whole point of a gate is that a named person answers it.
		const response = failClosed("the daemon is not answering");
		expect(response.exitCode).toBe(2);
		expect(JSON.parse(response.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
		expect(response.stderr).toContain("not answering");
	});
});

describe("the policy a machine holds", () => {
	it("refuses a persona it has no policy for", () => {
		const cache = new PolicyCache();
		const decision = cache.decide("pv_unknown", { tool: "ReadFile", args_text: "", action_classes: [] });
		expect(decision).toMatchObject({ verdict: "deny", rule: "no_policy" });
	});

	it("refuses on a policy past its lifetime, rather than trusting it a while longer", () => {
		// An expired policy is not "probably still right". Its owner may have
		// revoked a permission ten minutes ago.
		const cache = new PolicyCache(() => new Date(Date.now() + 7200 * 1000));
		cache.put(policy({ ttl_seconds: 60 }));
		const decision = cache.decide("pv_1", { tool: "ReadFile", args_text: "", action_classes: [] });
		expect(decision).toMatchObject({ verdict: "deny", rule: "stale_cache" });
	});

	it("decides normally while it is fresh", () => {
		const cache = new PolicyCache();
		cache.put(policy({ deny: ["rm -rf"] }));
		expect(cache.decide("pv_1", { tool: "Bash", args_text: "rm -rf /", action_classes: [] }).verdict).toBe(
			"deny",
		);
		expect(cache.decide("pv_1", { tool: "ReadFile", args_text: "x", action_classes: [] }).verdict).toBe(
			"allow",
		);
	});

	it("reports what it holds, so the workspace pushes only what changed", () => {
		const cache = new PolicyCache();
		cache.put(policy());
		expect(cache.summary()).toEqual([{ persona_version_id: "pv_1", hash: expect.any(String) }]);
	});
});

describe("the daemon deciding for a call", () => {
	const call = { tool_name: "Bash", args_text: "rm -rf /", cwd: "/work/repo" };

	it("refuses a directory the operator never exposed", () => {
		const handle = enforcementHandler({ cache: new PolicyCache(), personaVersionFor: () => null });
		return expect(handle(call)).resolves.toMatchObject({ verdict: "deny", rule: "out_of_scope" });
	});

	it("refuses a gated call when it cannot reach anyone to ask", async () => {
		// Holding it open instead would look like a hang, and teach people to
		// turn the hook off.
		const cache = new PolicyCache();
		cache.put(
			policy({
				gate_rules: [
					{ action_class: "file_delete", required_approvals: 1, route: {}, timeout_seconds: 600 },
				],
			}),
		);
		const handle = enforcementHandler({ cache, personaVersionFor: () => "pv_1" });
		await expect(handle(call)).resolves.toMatchObject({ verdict: "deny" });
	});

	it("lets the call through when a person approves", async () => {
		const cache = new PolicyCache();
		cache.put(
			policy({
				gate_rules: [
					{ action_class: "file_delete", required_approvals: 1, route: {}, timeout_seconds: 600 },
				],
			}),
		);
		const handle = enforcementHandler({
			cache,
			personaVersionFor: () => "pv_1",
			openGate: async () => "approved",
		});
		await expect(handle(call)).resolves.toMatchObject({ verdict: "allow" });
	});

	it("names who refused, or that nobody answered", async () => {
		const cache = new PolicyCache();
		cache.put(
			policy({
				gate_rules: [
					{ action_class: "file_delete", required_approvals: 1, route: {}, timeout_seconds: 600 },
				],
			}),
		);
		const denied = await enforcementHandler({
			cache,
			personaVersionFor: () => "pv_1",
			openGate: async () => "denied",
		})(call);
		expect(denied.reason).toContain("declined");

		const expired = await enforcementHandler({
			cache,
			personaVersionFor: () => "pv_1",
			openGate: async () => "expired",
		})(call);
		expect(expired.reason).toContain("in time");
	});
});

describe("compiling a persona into a policy", () => {
	it("carries the declared limits across, and nothing else", () => {
		const compiled = policyFromPersona(
			{
				permissions: { sandbox: "read-only", approval: "never", deny: ["rm -rf"], allow: ["^Read"] },
				self_regulation: { hard_limits: ["No unauthorized identity change."] },
				character: { prohibited_behaviors: ["Fabricating sources."] },
			},
			{ personaVersionId: "pv_1" },
		);
		expect(compiled.sandbox).toBe("read-only");
		expect(compiled.deny).toEqual(["rm -rf"]);
		expect(compiled.hard_limits).toEqual(["No unauthorized identity change."]);
		expect(compiled.gate_rules).toEqual([]);
	});

	it("falls to the conservative posture for a value the spec does not define", () => {
		// A persona that said `sandbox: "full"` must not end up freer than one
		// that said nothing at all.
		const compiled = policyFromPersona({ permissions: { sandbox: "full" } }, { personaVersionId: "pv" });
		expect(compiled.sandbox).toBe("workspace-write");
		expect(compiled.approval).toBe("on-request");
	});

	it("compiles the same persona to the same rules on both ends", () => {
		// The daemon compiles what is on disk and the workspace compiles what it
		// stores. If those disagreed, a persona would behave differently
		// depending on who compiled it.
		const at = new Date("2026-08-01T00:00:00.000Z");
		const source = { permissions: { deny: ["curl"] } };
		const a = policyFromPersona(source, { personaVersionId: "pv", now: at });
		const b = policyFromPersona(source, { personaVersionId: "pv", now: at });
		expect(a.hash).toBe(b.hash);
	});
});

describe("installing the hook in a project", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pxs-hookinstall-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function settings(): Record<string, any> {
		return JSON.parse(readFileSync(claudeCodeAdapter.settingsPath(root), "utf-8"));
	}

	it("installs a PreToolUse hook with no matcher, so it covers every tool", () => {
		// A matcher listing tool names is a list to keep in sync with a host that
		// keeps adding them, and the one it forgot is the one that runs unchecked.
		claudeCodeAdapter.install(root);
		const groups = settings().hooks.PreToolUse;
		expect(groups).toHaveLength(1);
		expect(groups[0].matcher).toBeUndefined();
		expect(groups[0].hooks[0].command).toContain(HOOK_MARKER);
		expect(groups[0].hooks[0].timeout).toBeGreaterThan(600);
	});

	it("is idempotent", () => {
		claudeCodeAdapter.install(root);
		claudeCodeAdapter.install(root);
		expect(settings().hooks.PreToolUse).toHaveLength(1);
	});

	it("leaves a project's own hooks alone, and takes only ours back out", () => {
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(
			claudeCodeAdapter.settingsPath(root),
			JSON.stringify({
				hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./mine.sh" }] }] },
				model: "opus",
			}),
		);

		claudeCodeAdapter.install(root);
		expect(settings().hooks.PreToolUse).toHaveLength(2);

		claudeCodeAdapter.uninstall(root);
		const after = settings();
		expect(after.hooks.PreToolUse).toHaveLength(1);
		expect(after.hooks.PreToolUse[0].hooks[0].command).toBe("./mine.sh");
		expect(after.model).toBe("opus");
	});

	it("refuses to overwrite settings it could not parse", () => {
		// Rewriting a file we failed to read would delete configuration someone
		// wrote by hand.
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(claudeCodeAdapter.settingsPath(root), "{ not json");
		expect(() => claudeCodeAdapter.install(root)).toThrow(/not valid JSON/);
	});

	it("reports whether it is installed", () => {
		expect(claudeCodeAdapter.status(root).installed).toBe(false);
		claudeCodeAdapter.install(root);
		expect(claudeCodeAdapter.status(root).installed).toBe(true);
	});
});
