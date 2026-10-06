/**
 * What a client sees while OUR persona works.
 *
 * The mirror of `acp-wire.ts`, and deliberately built on the same vocabulary in the
 * middle. Driving somebody else's agent, we translate their `session/update` into
 * our wire events. Being driven, we translate our wire events into their
 * `session/update`. One vocabulary at the centre and two translations at the edges
 * beats four translations between four shapes, which is what a second vocabulary
 * would have made this.
 *
 * The engine's own `mapLoopEvent` does the first half and is already tested: it is
 * what decides that a memory recall is internal and a tool call is not. Reusing it
 * means a client driving our persona sees exactly what the workspace sees, and a
 * decision about what is worth showing is made once.
 *
 * ## The reasoning does not leave the machine
 *
 * `agent.thought.streamed` carries what the persona said. There is deliberately no
 * mapping that sends the model's private reasoning, for the same reason the other
 * direction withholds `agent_thought_chunk`: a session shows what a persona did and
 * said, not what it considered and discarded. That we are the agent here rather than
 * the client does not change the rule; if anything it matters more, because it is
 * our persona's reasoning and somebody else's screen.
 */

import type { WireEmission } from "@personaxis/core";

/** An ACP `session/update` payload, ready for `sessionUpdate`. */
export type ServedUpdate = Record<string, unknown>;

/**
 * One wire event, as the client's session sees it.
 *
 * Returns undefined for the ones a client has no place to put. That is most of the
 * vocabulary and it is not a gap: gates, artifacts, steering and band crossings are
 * facts about a workspace run, and a persona embedded in somebody's editor has no
 * workspace. Sending them would put events in a session that mean nothing there,
 * which is worse than silence because a client would try to render them.
 */
export function servedUpdate(emission: WireEmission): ServedUpdate | undefined {
	switch (emission["kind"]) {
		case "agent.thought.streamed": {
			const text = String(emission["text"] ?? "");
			if (!text) return undefined;
			return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
		}

		case "tool.call.requested":
			return {
				sessionUpdate: "tool_call",
				toolCallId: String(emission["call_id"] ?? ""),
				title: String(emission["tool"] ?? "(unnamed)"),
				// `name` as well as `title`, because a client's own policy matches on the
				// name and we are on the receiving end of that reasoning here: handing an
				// editor only the human sentence is the mistake we made in the other
				// direction and had to correct in `A3`.
				name: String(emission["tool"] ?? "(unnamed)"),
				status: "pending",
				rawInput: emission["args_preview"] ?? "",
			};

		case "tool.call.completed":
			return {
				sessionUpdate: "tool_call_update",
				toolCallId: String(emission["call_id"] ?? ""),
				status: emission["ok"] === true ? "completed" : "failed",
				rawOutput: emission["output_preview"] ?? "",
			};

		case "tool.call.blocked":
			// A refusal IS a completion, and reporting it as one is the honest shape: the
			// call is over and it did not do what it was asked. Silence here would leave a
			// client showing a tool call that never finishes.
			return {
				sessionUpdate: "tool_call_update",
				toolCallId: String(emission["call_id"] ?? ""),
				status: "failed",
				rawOutput: `refused by ${String(emission["rule"] ?? "policy")}: ${String(emission["reason"] ?? "")}`,
			};

		default:
			return undefined;
	}
}

/**
 * What a persona tells a client about a call it wants to make.
 *
 * ACP's permission request wants a tool call and a set of options. The options are
 * ours to offer, and offering `allow_always` would be offering something we cannot
 * honour: a persona's policy is recompiled per run and "always" would be a promise
 * about future runs that nothing here can keep. So two options, once each.
 */
export function permissionRequest(
	sessionId: string,
	call: { name: string; args: unknown; id: string },
	reason: string,
): Record<string, unknown> {
	return {
		sessionId,
		toolCall: {
			toolCallId: call.id,
			title: reason ? `${call.name}: ${reason}` : call.name,
			name: call.name,
			rawInput: call.args,
			status: "pending",
		},
		options: [
			{ optionId: "allow", name: "Allow", kind: "allow_once" },
			{ optionId: "reject", name: "Reject", kind: "reject_once" },
		],
	};
}

/**
 * Whether the person on the other end said yes.
 *
 * Anything that is not an explicit selection of our allow option is a refusal,
 * including an outcome word this build does not know. A permission answer that
 * cannot be read is not a yes, and defaulting the other way would make an
 * unrecognised reply into consent.
 */
export function permissionGranted(response: Record<string, unknown> | undefined): boolean {
	const outcome = (response?.["outcome"] ?? {}) as { outcome?: unknown; optionId?: unknown };
	return outcome.outcome === "selected" && outcome.optionId === "allow";
}
