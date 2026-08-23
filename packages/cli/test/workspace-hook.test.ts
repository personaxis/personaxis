/**
 * The enforcement path, from the host's payload to the verdict.
 *
 * Every test here is about a way the answer could be wrong in the permissive
 * direction, because that is the only direction that matters: a refusal that
 * should have been an allow costs someone a retry, and an allow that should
 * have been a refusal is the product not working.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompiledPolicy } from "@personaxis/core";
import { hashPolicy, policyFromPersona } from "@personaxis/core";

import { enforcementHandler } from "../src/workspace/enforcement-service.js";
import { argsTextFor, failClosed, hookResponseFor, parseHookInput } from "../src/workspace/hook-protocol.js";
import {
	claudeCodeAdapter,
	hookCommandFor,
	hookInvocation,
	hookScriptPath,
	HOOK_MARKER,
	isOurHook,
} from "../src/workspace/host-adapter.js";
import {
	endpointAddress,
	enforcementEndpointToken,
	enforcementSocketPath,
} from "../src/workspace/enforcement-endpoint.js";
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
		const handle = enforcementHandler({
			cache: new PolicyCache(),
			scope: ["/somewhere-else"],
			personaVersionFor: () => "pv_1",
		});
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
		const handle = enforcementHandler({ cache, scope: ["/work/repo"], personaVersionFor: () => "pv_1" });
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
			scope: ["/work/repo"],
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
			scope: ["/work/repo"],
			personaVersionFor: () => "pv_1",
			openGate: async () => "denied",
		})(call);
		expect(denied.reason).toContain("declined");

		const expired = await enforcementHandler({
			cache,
			scope: ["/work/repo"],
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
		expect(isOurHook(groups[0].hooks[0].command)).toBe(true);
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

/**
 * The gap between writing a hook and a host running one.
 *
 * The file this lives beside has said since it was written that the most dangerous
 * state here is an operator believing calls are refused while nothing intercepts
 * them. What it did not say is that the ordinary way to reach that state is not a
 * bug: it is installing the package any way other than globally, because the command
 * named a bare `personaxis-hook` and nothing else.
 *
 * That was found by running a real job on this machine, where there is no global
 * install, and watching the agent's first `Bash` call run with no decision behind it.
 */
describe("the command the host is actually told to run", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "personaxis-hook-command-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("names this Node and an absolute script, so PATH is not in the way", () => {
		const command = hookInvocation(hookScriptPathThatExists());

		expect(command).toContain(process.execPath);
		expect(command).toContain(hookScriptPathThatExists());
	});

	it("falls back to the bare name when the script cannot be found", () => {
		// A hook that might resolve beats none. What it must not do is throw and
		// leave `connect` unable to install anything at all.
		expect(hookInvocation(join(root, "nothing", "hook-bin.js"))).toBe(HOOK_MARKER);
	});

	it("looks for the script where the package publishes it", () => {
		// A string compared against the filesystem, so moving the binary breaks this
		// rather than breaking enforcement quietly on somebody else's machine.
		const declared = JSON.parse(
			readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"),
		).bin["personaxis-hook"];

		expect(basename(hookScriptPath())).toBe(basename(declared));
		// It resolves next to the module, which is `src/` here and `dist/` when built.
		expect(existsSync(hookScriptPath()) || existsSync(hookScriptPath().replace(/\.js$/, ".ts"))).toBe(
			true,
		);
	});
});

describe("recognising our own hook, however it was written", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "personaxis-hook-forms-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("knows the bare form a global install wrote", () => {
		// The upgrade path. Failing here would install a second hook beside the first,
		// so every call would be gated twice, and would leave one behind on uninstall.
		expect(isOurHook('personaxis-hook --socket "/tmp/personaxis-enforce-abc.sock"')).toBe(true);
	});

	it("knows the absolute form, which contains none of the old name", () => {
		expect(isOurHook('"/usr/bin/node" "/opt/app/dist/hook-bin.js" --socket "/tmp/personaxis-enforce-abc.sock"')).toBe(
			true,
		);
	});

	it("does not claim somebody else's hook", () => {
		expect(isOurHook('./scripts/my-own-check.sh')).toBe(false);
		expect(isOurHook(undefined)).toBe(false);
	});

	it("takes back out a hook written in the old form", () => {
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(
			claudeCodeAdapter.settingsPath(root),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{ hooks: [{ type: "command", command: `${HOOK_MARKER} --socket "old"` }] },
						{ hooks: [{ type: "command", command: "./their-own.sh" }] },
					],
				},
			}),
		);

		claudeCodeAdapter.uninstall(root);
		const groups = JSON.parse(readFileSync(claudeCodeAdapter.settingsPath(root), "utf-8")).hooks
			.PreToolUse;

		expect(JSON.stringify(groups)).toContain("their-own.sh");
		expect(JSON.stringify(groups)).not.toContain(HOOK_MARKER);
	});

	it("does not install a second one over the old form", () => {
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(
			claudeCodeAdapter.settingsPath(root),
			JSON.stringify({
				hooks: {
					PreToolUse: [{ hooks: [{ type: "command", command: `${HOOK_MARKER} --socket "old"` }] }],
				},
			}),
		);

		claudeCodeAdapter.install(root);
		const groups = JSON.parse(readFileSync(claudeCodeAdapter.settingsPath(root), "utf-8")).hooks
			.PreToolUse;

		expect(groups).toHaveLength(1);
	});
});

/** A path that exists in both the source tree and the built one. */
function hookScriptPathThatExists(): string {
	return join(import.meta.dirname, "workspace-hook.test.ts");
}

/**
 * Surviving the shell that starts the hook.
 *
 * Every host we support runs a PreToolUse hook through a shell, and a Windows named
 * pipe address does not survive one: a POSIX shell turns the leading pair of
 * backslashes into a single one, so the hook connects to an address that does not
 * exist, fails closed, and refuses every call the agent makes.
 *
 * That was found in a real job on this machine and not by reading. All three of its
 * tool calls, including the one the policy allowed, came back with
 * `connect ENOENT` while the daemon was listening on the pipe next door.
 *
 * So the test is the shell, imitated: take the argument the way it is written, undo
 * what a shell does to it, and require the address to still be the right one.
 */
describe("what survives being written into a shell command", () => {
	const root = "C:@@Users@@daqc@@Documents@@GitHub@@cli".split("@@").join(BACKSLASH);

	/** What a POSIX shell leaves of a double-quoted argument. */
	function throughAShell(argument: string): string {
		return argument.split(BACKSLASH + BACKSLASH).join(BACKSLASH);
	}

	function endpointIn(command: string): string {
		const match = /--endpoint "([^"]*)"/.exec(command);
		expect(match, `no --endpoint in: ${command}`).not.toBeNull();
		return match![1];
	}

	it("carries a token with no backslash in it", () => {
		// The whole fix in one assertion: nothing for a shell to eat.
		const token = endpointIn(hookCommandFor(root));

		expect(token.includes(BACKSLASH)).toBe(process.platform !== "win32");
	});

	it("still names the same endpoint after a shell has had it", () => {
		const token = endpointIn(hookCommandFor(root));

		expect(endpointAddress(throughAShell(token))).toBe(enforcementSocketPath(root));
	});

	it("rebuilds exactly the address the daemon listens on", () => {
		expect(endpointAddress(enforcementEndpointToken(root))).toBe(enforcementSocketPath(root));
	});

	it("leaves an address alone when it is already one", () => {
		// `--socket` from an older version, and every POSIX path.
		const posix = "/run/user/1000/personaxis-enforce-abc.sock";

		expect(endpointAddress(posix)).toBe(posix);
	});

	it("gives two directories two endpoints", () => {
		// A machine serving two consented directories answers on both, and a hook in
		// one must not reach the daemon serving the other.
		expect(enforcementEndpointToken(root)).not.toBe(enforcementEndpointToken(root + BACKSLASH + "other"));
	});
});

describe("an upgrade that changes how the hook is started", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "personaxis-hook-upgrade-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("rewrites the command instead of leaving the old one", () => {
		// Returning early on any hook of ours meant a machine kept running the command
		// it was first installed with, forever. The only symptom is enforcement quietly
		// not happening, which is the symptom nobody sees.
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(
			claudeCodeAdapter.settingsPath(root),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{ hooks: [{ type: "command", command: `${HOOK_MARKER} --socket "ancient"`, timeout: 5 }] },
					],
				},
			}),
		);

		claudeCodeAdapter.install(root);
		const groups = JSON.parse(readFileSync(claudeCodeAdapter.settingsPath(root), "utf-8")).hooks
			.PreToolUse;

		expect(groups).toHaveLength(1);
		expect(groups[0].hooks[0].command).toBe(hookCommandFor(root));
		expect(groups[0].hooks[0].timeout).toBeGreaterThan(600);
	});
});

/** One backslash, spelled out, because this file is about what happens to them. */
const BACKSLASH = "\\";

/**
 * Consent and identity are two questions, and were one.
 *
 * The guard asked whether a persona was registered for the directory and answered
 * `out_of_scope` when it was not. Those come apart the moment a persona arrives from
 * the workspace rather than from a local file: the operator had typed `--dir` for
 * exactly that folder, every call in it was refused, and the message told them to
 * add it with `--dir`. Advice somebody has already followed is worse than none.
 *
 * Found by assigning a real job to a real daemon and watching all four of its tool
 * calls come back refused for a directory that was in `connect`'s own output.
 */
describe("a directory the operator did expose", () => {
	const call = { tool_name: "Bash", args_text: "ls", cwd: "/work/repo" };

	it("is not called out of scope just because no persona is known there", async () => {
		const reply = await enforcementHandler({
			cache: new PolicyCache(),
			scope: ["/work/repo"],
			personaVersionFor: () => null,
		})(call);

		expect(reply.rule).not.toBe("out_of_scope");
		expect(reply.reason).not.toContain("connect --dir");
	});

	it("is still refused, under a name that says what is actually missing", async () => {
		// Fail-closed either way. What changes is where it sends the operator.
		const reply = await enforcementHandler({
			cache: new PolicyCache(),
			scope: ["/work/repo"],
			personaVersionFor: () => null,
		})(call);

		expect(reply.verdict).toBe("deny");
		expect(reply.rule).toBe("no_persona");
	});

	it("covers what is under it, not only the directory itself", async () => {
		const reply = await enforcementHandler({
			cache: new PolicyCache(),
			scope: ["/work"],
			personaVersionFor: () => null,
		})({ ...call, cwd: "/work/repo/src" });

		expect(reply.rule).toBe("no_persona");
	});

	it("refuses everywhere when nothing was consented to", async () => {
		// Empty means empty, which is the same direction `connect` takes.
		const reply = await enforcementHandler({
			cache: new PolicyCache(),
			scope: [],
			personaVersionFor: () => "pv_1",
		})(call);

		expect(reply.rule).toBe("out_of_scope");
	});

	it("does not let a neighbouring name in", async () => {
		// `/work/repo-other` starts with `/work/repo` as a string and is a different
		// directory. A prefix check without the separator would expose it.
		const reply = await enforcementHandler({
			cache: new PolicyCache(),
			scope: ["/work/repo"],
			personaVersionFor: () => "pv_1",
		})({ ...call, cwd: "/work/repo-other" });

		expect(reply.rule).toBe("out_of_scope");
	});
});

/**
 * What a gated call is told now that there is somewhere to ask.
 *
 * The refusal these replace was honest and permanent: "this machine cannot reach
 * the workspace to ask for it", returned because `openGate` was never provided.
 * A persona whose posture is `on-request` therefore ran and could do nothing.
 *
 * The four endings are kept apart on purpose. Three are answers; the fourth is the
 * absence of anyone to answer, and telling an operator that nobody replied in time
 * to a question that was never asked sends them looking in the wrong place.
 */
describe("a call that needs a person", () => {
	const gated = () => {
		const cache = new PolicyCache();
		cache.put(
			policy({
				gate_rules: [
					{ action_class: "file_delete", required_approvals: 1, route: {}, timeout_seconds: 600 },
				],
			}),
		);
		return cache;
	};

	const call = { tool_name: "Bash", args_text: "rm -rf /", cwd: "/work/repo" };

	it("hands the gate everything a person needs, including where it happened", async () => {
		// The directory travels because a gate is an event on a run and a call
		// names none. Without it the relay has nothing to look up.
		const openGate = vi.fn().mockResolvedValue("approved");

		await enforcementHandler({
			cache: gated(),
			scope: ["/work/repo"],
			personaVersionFor: () => "pv_1",
			openGate,
		})(call);

		expect(openGate).toHaveBeenCalledWith(
			expect.objectContaining({
				tool: "Bash",
				action_class: "file_delete",
				required_approvals: 1,
				cwd: "/work/repo",
				reason: expect.stringContaining("file_delete"),
			}),
		);
	});

	it("lets it through when a person says yes", async () => {
		const reply = await enforcementHandler({
			cache: gated(),
			scope: ["/work/repo"],
			personaVersionFor: () => "pv_1",
			openGate: async () => "approved",
		})(call);

		expect(reply.verdict).toBe("allow");
	});

	it("names a decline as a decline", async () => {
		const reply = await enforcementHandler({
			cache: gated(),
			scope: ["/work/repo"],
			personaVersionFor: () => "pv_1",
			openGate: async () => "denied",
		})(call);

		expect(reply.verdict).toBe("deny");
		expect(reply.reason).toContain("declined");
	});

	it("names nobody-to-ask apart from nobody-answered", async () => {
		const unreachable = await enforcementHandler({
			cache: gated(),
			scope: ["/work/repo"],
			personaVersionFor: () => "pv_1",
			openGate: async () => "unreachable",
		})(call);
		const expired = await enforcementHandler({
			cache: gated(),
			scope: ["/work/repo"],
			personaVersionFor: () => "pv_1",
			openGate: async () => "expired",
		})(call);

		expect(unreachable.reason).toContain("no run is in flight");
		expect(expired.reason).toContain("in time");
		expect(unreachable.reason).not.toBe(expired.reason);
	});

	it("still refuses when nothing was wired to ask with", async () => {
		// The state this whole path was in. It has to keep failing closed.
		const reply = await enforcementHandler({
			cache: gated(),
			scope: ["/work/repo"],
			personaVersionFor: () => "pv_1",
		})(call);

		expect(reply.verdict).toBe("deny");
	});
});
