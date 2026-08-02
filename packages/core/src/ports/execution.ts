/**
 * F2, the execution port: where an allowed action actually happens.
 *
 * The storage ports (F3.3) took the engine off a local filesystem for STATE. This takes it
 * off a local machine for ACTIONS. Same reason, different half: the loop already does not
 * care where `state.json` lives, and it should not care whether a command runs on the
 * operator's laptop through `spawn` or inside a container the workspace started. The desk
 * must not be able to tell, except for one line saying where.
 *
 * WHAT THIS IS NOT. It is not a security boundary and it must never be mistaken for one.
 * Gating happens BEFORE anything reaches here: the agent evaluates the call against the
 * compiled policy and only an `allow` gets this far. An implementation of this interface is
 * therefore trusted to run what it is given, which is exactly why a remote one has to be
 * given nothing but what was already approved. Putting the check inside the port would move
 * enforcement into the thing furthest from the operator's consent, and a hosted runner
 * would be enforcing on itself.
 *
 * THE PROPERTY THAT MAKES A SWAP SAFE: every implementation returns the same shapes for the
 * same outcomes, including the failures. A remote runner whose timeout produced a different
 * result shape than a local one would make the loop behave differently depending on where
 * it ran, which is the thing this exists to prevent, and it would show up as a run that
 * "works locally".
 */

import type { ExecResult, FileResult } from "../tools/exec.js";
import {
	executeCommand,
	executeFileEdit,
	executeFileWrite,
	listDirSafe,
	readFileSafe,
} from "../tools/exec.js";
import type { Policy } from "../sandbox.js";

/** Where a run happened. One line on the desk, and nothing else changes. */
export type ExecutionLocation = "machine" | "hosted";

export interface ExecutionPort {
	/**
	 * Named so a person reading a record knows which machine to look at. Not an identifier
	 * the engine branches on: a loop that behaved differently per location would be two
	 * loops, and only one of them would be tested.
	 */
	readonly location: ExecutionLocation;
	/** Human-readable, for the one line: "this machine", "sandbox job_1f2e". */
	readonly describe: string;

	runCommand(cmd: string, policy: Policy, opts?: { timeoutMs?: number }): Promise<ExecResult>;
	writeFile(path: string, content: string, policy: Policy): Promise<FileResult>;
	editFile(path: string, find: string, replace: string, policy: Policy): Promise<FileResult>;
	readFile(path: string, policy: Policy): Promise<FileResult>;
	listDir(path: string, policy: Policy): Promise<FileResult>;
}

/**
 * The reference implementation: this machine, through the executors that already existed.
 *
 * Async on an interface whose local implementation is synchronous, deliberately. A remote
 * runner cannot be synchronous, and a port shaped around the local case would force every
 * caller to be rewritten the day the second implementation arrives. That rewrite is exactly
 * the "engine learns something new" that F2 exists to avoid.
 */
export function localExecution(): ExecutionPort {
	return {
		location: "machine",
		describe: "this machine",

		async runCommand(cmd, policy, opts) {
			return executeCommand(cmd, policy, opts);
		},
		async writeFile(path, content, policy) {
			return executeFileWrite(path, content, policy);
		},
		async editFile(path, find, replace, policy) {
			return executeFileEdit(path, find, replace, policy);
		},
		async readFile(path, policy) {
			return readFileSafe(path, policy);
		},
		async listDir(path, policy) {
			return listDirSafe(path, policy);
		},
	};
}

/**
 * A port that refuses everything, for a runtime with nowhere to act.
 *
 * The hosted path needs this before a sandbox is up, and the honest answer then is a
 * refusal that says why. The alternative is falling back to local execution, which would
 * silently run a hosted job's commands on whatever machine happened to be hosting the
 * process: the single worst outcome this file can produce, and the easiest to reach by
 * accident with a `?? localExecution()`.
 */
export function noExecution(reason: string): ExecutionPort {
	// The same shape a real refusal has, so a caller cannot tell this apart by structure and
	// take a different path. It reads as a failed action, which is what it is.
	const why = `no execution environment: ${reason}`;
	const refusedFile = (path: string): FileResult => ({ ok: false, path, error: why });

	return {
		location: "hosted",
		describe: `nowhere to run (${reason})`,

		async runCommand() {
			return { ok: false, code: null, stdout: "", stderr: why, truncated: false, timedOut: false };
		},
		async writeFile(path) {
			return refusedFile(path);
		},
		async editFile(path) {
			return refusedFile(path);
		},
		async readFile(path) {
			return refusedFile(path);
		},
		async listDir(path) {
			return refusedFile(path);
		},
	};
}
