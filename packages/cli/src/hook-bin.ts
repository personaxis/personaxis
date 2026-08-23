#!/usr/bin/env node
/**
 * `personaxis-hook`, the process a host spawns before every tool call.
 *
 * A separate binary rather than a subcommand, for one reason: this runs in
 * front of every single tool call, and the decision has a 150 ms budget. Booting
 * the whole CLI to answer one question would spend most of that budget on
 * loading commander and forty command modules. Its imports are deliberately
 * three files deep and it holds no engine state.
 *
 * It decides nothing. It reads the host's payload, asks the daemon over a local
 * socket, and translates the answer back into the host's contract. Every path
 * that is not a clear allow ends in a refusal, including the paths where this
 * process itself is what went wrong.
 */

import { argsTextFor, failClosed, parseHookInput, type HookResponse } from "./workspace/hook-protocol.js";
import {
	askDaemon,
	endpointAddress,
	enforcementSocketPath,
} from "./workspace/enforcement-endpoint.js";

/**
 * How long to wait for the daemon.
 *
 * Well inside the host's own hook timeout, so a daemon that stopped answering
 * produces our refusal with a reason rather than the host's timeout with none.
 * A gate that a person has to answer takes longer than this by design, and the
 * daemon says so on the socket before this fires.
 */
const ASK_TIMEOUT_MS = 5000;

/** A gate is a person deciding. The wait is theirs, not ours. */
const GATE_TIMEOUT_MS = 30 * 60 * 1000;

/** One flag, read positionally, because that is the whole of this argument surface. */
function flag(name: string): string | undefined {
	const at = process.argv.indexOf(name);
	return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
	// `--endpoint` carries a token the daemon computed; `--socket` carried the
	// address itself and is still accepted, because a settings file written by an
	// older version is on somebody's disk right now and must keep working.
	const endpointArg = flag("--endpoint") ?? flag("--socket");

	const raw = await readStdin();
	const input = parseHookInput(raw);
	if (!input?.tool_name) {
		// A payload with no tool name is either a host that changed its contract
		// or something that is not the host at all. Neither is a reason to let a
		// call through unchecked.
		return finish(failClosed("the hook payload had no tool name"));
	}

	const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	const socketPath = endpointArg ? endpointAddress(endpointArg) : enforcementSocketPath(cwd);

	// The wait is the gate's, because the daemon holds the connection open while
	// a person decides. The shorter timeout only covers reaching it at all.
	const request = {
		tool_name: input.tool_name,
		args_text: argsTextFor(input.tool_input),
		cwd,
		tool_use_id: input.tool_use_id,
		session_id: input.session_id,
	};

	try {
		const reply = await askDaemon(socketPath, request, GATE_TIMEOUT_MS + ASK_TIMEOUT_MS);
		return finish(
			reply.verdict === "allow"
				? {
						stdout: JSON.stringify({
							hookSpecificOutput: {
								hookEventName: "PreToolUse",
								permissionDecision: "allow",
								permissionDecisionReason: reply.rule,
							},
						}),
						stderr: "",
						exitCode: 0,
					}
				: {
						stdout: JSON.stringify({
							hookSpecificOutput: {
								hookEventName: "PreToolUse",
								permissionDecision: "deny",
								permissionDecisionReason: `${reply.reason} [${reply.rule}]`,
							},
						}),
						stderr: `${reply.reason} [${reply.rule}]`,
						exitCode: 2,
					},
		);
	} catch (error) {
		return finish(
			failClosed(
				`the daemon on this machine is not answering (${error instanceof Error ? error.message : String(error)}). Is \`personaxis connect\` running?`,
			),
		);
	}
}

function finish(response: HookResponse): void {
	if (response.stdout) process.stdout.write(response.stdout);
	if (response.stderr) process.stderr.write(response.stderr);
	process.exit(response.exitCode);
}

function readStdin(): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data));
		// A host that spawned this without a payload would otherwise hang until
		// its own timeout, and then let the call through.
		process.stdin.on("error", () => resolve(""));
	});
}

main().catch((error) => {
	finish(failClosed(`the hook itself failed: ${error instanceof Error ? error.message : String(error)}`));
});
