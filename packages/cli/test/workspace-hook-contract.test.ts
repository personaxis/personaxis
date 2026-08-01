/**
 * The contract test: the real binary, a real socket, a real refusal.
 *
 * Everything else about enforcement is unit tested, and none of that would
 * notice the failure that matters. If Claude Code changes what it sends, or
 * what it reads back, or what an exit code means, our decision function keeps
 * returning the right verdict into a void and every call runs. The failure is
 * silent by nature: nothing errors, the agent just stops being governed.
 *
 * So this spawns the built `personaxis-hook` exactly as the host does, feeds it
 * the documented payload on stdin, and asserts on the two things the host
 * actually acts on: the exit code, and stderr.
 *
 * What it does not cover, stated rather than implied: Claude Code itself is not
 * in this loop. Running it would need the host installed and an API key, which
 * CI has neither of. This proves our end of the contract against the contract
 * as documented. A change on their side that keeps the shape and changes the
 * meaning would pass here and fail in the world, and the answer to that is the
 * version-pinned smoke test on a real machine, not a green tick in CI.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
	enforcementSocketPath,
	serveEnforcement,
	type EnforceReply,
	type EnforceRequest,
} from "../src/workspace/enforcement-endpoint.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_BIN = join(HERE, "..", "dist", "hook-bin.js");

/** The payload the host documents for PreToolUse. */
function hostPayload(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		session_id: "sess_1",
		transcript_path: "/tmp/transcript.jsonl",
		cwd: "/work/repo",
		permission_mode: "default",
		hook_event_name: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command: "rm -rf /" },
		tool_use_id: "toolu_1",
		...overrides,
	});
}

interface HookResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runHook(payload: string, socketPath?: string): Promise<HookResult> {
	return new Promise((resolve, reject) => {
		const args = [HOOK_BIN, ...(socketPath ? ["--socket", socketPath] : [])];
		const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
		child.stdin.write(payload);
		child.stdin.end();
	});
}

let server: Server | null = null;

function serve(reply: (request: EnforceRequest) => EnforceReply): string {
	const path = enforcementSocketPath(`contract-${Math.random()}`);
	server = serveEnforcement(path, async (request) => reply(request));
	return path;
}

afterEach(() => {
	server?.close();
	server = null;
});

const built = existsSync(HOOK_BIN);

describe.skipIf(!built)("the hook, as the host runs it", () => {
	it("blocks a refused call with exit 2 and the reason on stderr", async () => {
		// This is the assertion the product rests on. Exit 2 is what prevents the
		// tool call; stderr is what the agent is told about it.
		const socket = serve(() => ({
			verdict: "deny",
			rule: "deny:rm -rf",
			reason: "permissions.deny matched: rm -rf",
		}));

		const result = await runHook(hostPayload(), socket);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("permissions.deny matched: rm -rf");
	});

	it("lets an allowed call through with exit 0 and the documented decision", async () => {
		const socket = serve(() => ({ verdict: "allow", rule: "approval:never", reason: "" }));

		const result = await runHook(hostPayload({ tool_input: { command: "npm test" } }), socket);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
		});
	});

	it("passes the call through to the daemon as the daemon expects it", async () => {
		let seen: EnforceRequest | null = null;
		const socket = serve((request) => {
			seen = request;
			return { verdict: "allow", rule: "ok", reason: "" };
		});

		await runHook(hostPayload(), socket);
		expect(seen).toMatchObject({ tool_name: "Bash", cwd: "/work/repo", tool_use_id: "toolu_1" });
		// The arguments have to arrive as text a policy can match, values and all.
		expect(seen?.args_text).toContain("rm -rf /");
	});

	it("refuses when no daemon is listening", async () => {
		// The most common failure in the world: the machine is not connected. It
		// has to fail closed, or enforcement is optional whenever a process died.
		const result = await runHook(hostPayload(), enforcementSocketPath("nothing-here"));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("refused");
	});

	it("refuses a payload it cannot read", async () => {
		const result = await runHook("not json at all", enforcementSocketPath("nothing-here"));
		expect(result.code).toBe(2);
	});

	it("answers inside the budget a person would notice", async () => {
		// The decision itself is microseconds (measured in the core suite). What
		// the operator feels is this: process start, one socket round trip, exit.
		// Measured on the development machine at p50 101 ms, p95 114 ms against a
		// 150 ms budget, and almost all of it is Node starting up. That is the
		// reason the hook is its own binary rather than a subcommand.
		//
		// The bound here is wide on purpose: it asserts the shape of the work,
		// not the speed of whatever runs CI. What it catches is the change that
		// starts importing the engine into this path.
		const socket = serve(() => ({ verdict: "allow", rule: "ok", reason: "" }));
		const samples: number[] = [];
		for (let i = 0; i < 5; i++) {
			const started = Date.now();
			await runHook(hostPayload({ tool_input: { command: "npm test" } }), socket);
			samples.push(Date.now() - started);
		}
		samples.sort((a, b) => a - b);
		expect(samples[samples.length - 1]).toBeLessThan(1500);
	});

	it("refuses a payload with no tool name, which is what a changed contract looks like", async () => {
		// If the host renames `tool_name`, this is the shape we would receive.
		// Refusing means a contract change is noticed as an agent that stopped
		// working, not as an agent that stopped being governed.
		const result = await runHook(JSON.stringify({ hook_event_name: "PreToolUse", cwd: "/work/repo" }));
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("tool name");
	});
});

describe("the contract this pins", () => {
	it("names the fields we depend on, so a change to them is a failing test", () => {
		// Deliberately a literal list rather than a type: it is a record of what
		// the vendor documented on the day this was written, and the thing that
		// makes the next person check.
		expect({
			stdin: ["tool_name", "tool_input", "cwd", "tool_use_id", "session_id"],
			blocking_exit_code: 2,
			allow_exit_code: 0,
			json: ["hookSpecificOutput", "hookEventName", "permissionDecision", "permissionDecisionReason"],
			decisions: ["allow", "deny", "ask", "defer"],
			settings_event: "PreToolUse",
		}).toMatchInlineSnapshot(`
			{
			  "allow_exit_code": 0,
			  "blocking_exit_code": 2,
			  "decisions": [
			    "allow",
			    "deny",
			    "ask",
			    "defer",
			  ],
			  "json": [
			    "hookSpecificOutput",
			    "hookEventName",
			    "permissionDecision",
			    "permissionDecisionReason",
			  ],
			  "settings_event": "PreToolUse",
			  "stdin": [
			    "tool_name",
			    "tool_input",
			    "cwd",
			    "tool_use_id",
			    "session_id",
			  ],
			}
		`);
	});
});
