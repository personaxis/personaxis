/**
 * The persona's policy answering an agent it is driving.
 *
 * The hook has always been the daemon's enforcement, and it is written into the
 * project's settings. Measured on 2026-09-03: the ACP adapter drives Claude Code
 * with `settingSources: ["user"]` or `[]`, and neither loads project settings, so an
 * agent driven this way never runs it. Without this file the ACP path is a road with
 * the enforcement missing, and the screens would not know.
 *
 * ## One gate, asked twice, rather than two gates
 *
 * The obvious thing is a policy check written for ACP. It is also the thing that
 * rots: two implementations of one rule diverge, and the divergence surfaces as a
 * call allowed down one road and refused down the other, with a person unable to say
 * which answer the product meant.
 *
 * So this asks `enforcementHandler`, the same function the hook's socket serves. Every
 * guard, the waterfall, the gate that opens a question to a person, the reporting into
 * the record: all of it happens once, and this is a translation into and out of it.
 *
 * ## What the hook could never do, and this can
 *
 * A hook fires and the tool runs unless it is refused, which means enforcement is a
 * veto applied to somebody else's decision. ACP asks first: the agent is waiting on
 * an answer and does nothing until it has one. Same policy, and a refusal that comes
 * before rather than after.
 */

import type { EnforceHandler } from "./enforcement-endpoint.js";
import type { PermissionAnswer, PermissionAsk } from "./acp-session.js";

/**
 * How much of a call's arguments the gate is shown.
 *
 * The same bound the hook lives under. A policy decides on what a call is and where
 * it points, and neither needs a megabyte of file content; passing one would put it
 * through every guard, into the gate event a person reads, and into the record.
 */
const ARGS_LIMIT = 4_000;

/** Arguments as text, for a gate that judges text. */
export function argsTextOf(rawInput: unknown): string {
	if (rawInput === undefined || rawInput === null) return "";
	if (typeof rawInput === "string") return rawInput.slice(0, ARGS_LIMIT);
	try {
		return JSON.stringify(rawInput).slice(0, ARGS_LIMIT);
	} catch {
		// Circular, or something with a throwing getter. The call is still judged, on
		// its name and its directory, rather than refused for being unprintable.
		return "";
	}
}

/**
 * Turns the daemon's enforcement into an answer an ACP client can give.
 *
 * The handler is passed rather than built, because who owns it is `connect`'s
 * business: it is the same instance the sockets serve, and a second one would hold a
 * second cache.
 */
export function permissionFrom(
	handler: EnforceHandler,
): (cwd: string, ask: PermissionAsk) => Promise<PermissionAnswer> {
	return async (cwd, ask) => {
		let reply;
		try {
			reply = await handler({
				// The tool's NAME, never its title. A title is written for a person
				// ("Reading a.ts") and a policy is written about a tool ("Read"), so
				// judging the title is a gate that can never match a rule and would
				// refuse everything while looking like it was working.
				tool_name: ask.toolName,
				args_text: argsTextOf(ask.rawInput),
				cwd,
				...(ask.callId ? { tool_use_id: ask.callId } : {}),
			});
		} catch (error) {
			// A gate that cannot answer refuses. The alternative is an agent allowed to
			// act because the thing that decides broke, which is the one failure mode
			// this product exists to make impossible.
			const message = error instanceof Error ? error.message : String(error);
			return { allow: false, reason: `the gate could not answer: ${message}` };
		}

		if (reply.verdict === "allow") return { allow: true };
		// The rule and the reason both, because a refusal a person cannot trace to a
		// rule is a refusal they will work around rather than understand.
		return { allow: false, reason: reply.rule ? `${reply.rule}: ${reply.reason}` : reply.reason };
	};
}
