/**
 * The contract with Claude Code's PreToolUse hook, in one place.
 *
 * This is the seam where the product's central claim becomes mechanical. A
 * prompt that says "never email a customer without approval" is a request, and
 * a request can be argued, confused or injected out of. A hook that returns
 * before the tool runs is not a request, because the call does not execute.
 *
 * Everything the host's contract touches lives here, and nothing else does, so
 * the day the host changes its shape there is exactly one file to change and
 * one test that fails. As of Claude Code's current hooks reference:
 *
 *   stdin  JSON with session_id, transcript_path, cwd, permission_mode,
 *          hook_event_name, tool_name, tool_input, tool_use_id
 *   exit 0 stdout is parsed for JSON; no decision means normal permission flow
 *   exit 2 blocking. stdout JSON is IGNORED and stderr is the reason shown
 *   JSON   hookSpecificOutput.permissionDecision: allow | deny | ask | defer
 *
 * The last line of that list is why a denial writes its reason to stderr and
 * not only to the JSON: on exit 2 the host does not read the JSON at all, and a
 * refusal whose reason went to the ignored channel is a refusal nobody can act
 * on.
 */

import type { PolicyDecision } from "@personaxis/core";

/** What the host sends. Every field optional: this is untrusted input. */
export interface HookInput {
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	permission_mode?: string;
	hook_event_name?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_use_id?: string;
}

export interface HookResponse {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Reads the host's payload. Never throws.
 *
 * A hook that crashed on a malformed payload would exit non-zero with a stack
 * trace, which the host reads as a non-blocking error: the call would run. So
 * a payload this cannot read becomes an input with no tool name, and the
 * caller decides what to do with that (it denies).
 */
export function parseHookInput(raw: string): HookInput | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as HookInput;
	} catch {
		return null;
	}
}

/**
 * Flattens the tool's arguments into the text a policy matches against.
 *
 * Deterministic by construction: keys sorted, one line. Two identical calls
 * must produce the same string, because that string feeds both a decision and
 * a hash, and a decision that depended on key order would be a decision that
 * changes between runs of the same command.
 *
 * Values are included, not just keys. A policy that could only see
 * `{"command"}` and not `rm -rf /` would be unable to deny anything worth
 * denying.
 */
export function argsTextFor(toolInput: unknown): string {
	if (toolInput == null) return "";
	if (typeof toolInput === "string") return toolInput;
	try {
		return JSON.stringify(toolInput, sortedKeys(toolInput));
	} catch {
		// Circular or otherwise unserialisable. Better a lossy string than a
		// throw: the decision still has the tool name and the classes.
		return String(toolInput);
	}
}

function sortedKeys(value: unknown): string[] | undefined {
	const keys = new Set<string>();
	const walk = (node: unknown, depth: number): void => {
		if (depth > 6 || node === null || typeof node !== "object") return;
		for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
			keys.add(key);
			walk(child, depth + 1);
		}
	};
	walk(value, 0);
	return keys.size === 0 ? undefined : [...keys].sort();
}

/**
 * Turns a decision into what the host expects.
 *
 * `ask` is deliberately never returned. Escalating to the host's own permission
 * prompt would put the question in front of whoever happens to be at that
 * keyboard, and the whole point of a gate is that a named person with the right
 * role answers it, in the workspace, on the record. A gate that the daemon
 * could not resolve is a denial.
 */
export function hookResponseFor(decision: PolicyDecision): HookResponse {
	if (decision.verdict === "allow") {
		return {
			stdout: JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "allow",
					permissionDecisionReason: decision.rule,
				},
			}),
			stderr: "",
			exitCode: 0,
		};
	}

	const reason =
		decision.verdict === "deny"
			? `${decision.reason} [${decision.rule}]`
			: `waiting for approval was not resolved [${decision.rule}]`;

	return {
		// Written anyway, for a host that reads it, and for a person reading a
		// transcript. The host ignores it on exit 2; stderr is what it shows.
		stdout: JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: reason,
			},
		}),
		stderr: reason,
		exitCode: 2,
	};
}

/**
 * The answer when the daemon cannot be reached, or is too slow, or the payload
 * could not be read.
 *
 * Denial, always. This is the one decision in the system that has to be wrong
 * in a safe direction: a machine whose control plane is unreachable is a
 * machine whose limits cannot be checked, and a limit that stops applying when
 * a socket drops is not a limit.
 */
export function failClosed(why: string): HookResponse {
	const reason = `personaxis could not check this call, so it was refused: ${why}`;
	return {
		stdout: JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: reason,
			},
		}),
		stderr: reason,
		exitCode: 2,
	};
}
