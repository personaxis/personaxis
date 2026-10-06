/**
 * What the room sees while an ACP agent works.
 *
 * The translator is pure, so every path of it is testable, and every path of it is
 * something a person watching a run will believe happened.
 */

import { describe, expect, it } from "vitest";

import { AcpWireTranslator, sessionEnded } from "../src/workspace/acp-wire.js";
import type { SkipReason } from "../src/workspace/host-stream.js";

function translator(): {
	acp: AcpWireTranslator;
	skips: { reason: SkipReason; detail: string }[];
} {
	const skips: { reason: SkipReason; detail: string }[] = [];
	return {
		acp: new AcpWireTranslator({ onSkip: (reason, detail) => skips.push({ reason, detail }) }),
		skips,
	};
}

const said = (text: string) => ({
	sessionUpdate: "agent_message_chunk",
	content: { type: "text", text },
});

describe("a turn, opened and closed", () => {
	it("agrees with itself about which turn it is", () => {
		const { acp } = translator();
		expect(acp.started()).toEqual([{ kind: "agent.turn.started", turn: 1 }]);
		expect(acp.ended()).toEqual([{ kind: "agent.turn.ended", turn: 1 }]);
		expect(acp.started()).toEqual([{ kind: "agent.turn.started", turn: 2 }]);
		expect(acp.ended()).toEqual([{ kind: "agent.turn.ended", turn: 2 }]);
	});

	it("summarises the turn with what the agent last said", () => {
		const { acp } = translator();
		acp.started();
		acp.update(said("first"));
		acp.update(said("last"));
		expect(acp.ended()).toEqual([{ kind: "agent.turn.ended", turn: 1, summary: "last" }]);
	});

	it("carries no summary when the agent said nothing, rather than an empty one", () => {
		// An empty summary renders as a turn that produced a blank. No summary renders
		// as a turn with nothing to summarise, which is the true one.
		const { acp } = translator();
		acp.started();
		expect(acp.ended()[0]).not.toHaveProperty("summary");
	});

	it("forgets the previous turn's summary when a new one opens", () => {
		const { acp } = translator();
		acp.started();
		acp.update(said("from turn one"));
		acp.ended();
		acp.started();
		expect(acp.ended()[0]).not.toHaveProperty("summary");
	});
});

describe("what the agent says, and what it only thinks", () => {
	it("publishes the answer", () => {
		const { acp } = translator();
		expect(acp.update(said("done"))).toEqual([
			{ kind: "agent.thought.streamed", text: "done" },
		]);
	});

	it("withholds the reasoning, and says that it did", () => {
		// A shared room shows what a persona did and said, not what it considered and
		// discarded. `host-stream.ts` makes the same call for the same reason.
		const { acp, skips } = translator();
		const events = acp.update({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "maybe I should rm -rf" },
		});
		expect(events).toEqual([]);
		expect(skips).toEqual([{ reason: "withheld", detail: "agent_thought_chunk" }]);
	});

	it("does not put our own question in the room a second time", () => {
		const { acp } = translator();
		expect(acp.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "do it" } })).toEqual([]);
	});

	it("ignores a chunk with no text rather than publishing a blank", () => {
		const { acp } = translator();
		expect(acp.update({ sessionUpdate: "agent_message_chunk", content: { type: "image" } })).toEqual([]);
	});
});

describe("tool calls, which arrive several times for one action", () => {
	it("announces a call once and completes it once", () => {
		const { acp } = translator();

		expect(acp.update({ sessionUpdate: "tool_call", toolCallId: "c1", name: "read", rawInput: "a.ts", status: "pending" })).toEqual([
			{ kind: "tool.call.requested", call_id: "c1", tool: "read", args_preview: "a.ts" },
		]);
		// In progress is a state change, not an event this room shows.
		expect(acp.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" })).toEqual([]);
		expect(acp.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: "ok" })).toEqual([
			{ kind: "tool.call.completed", call_id: "c1", ok: true, output_preview: "ok" },
		]);
	});

	it("reports a failed call as not ok, which is a result and not an error", () => {
		const { acp } = translator();
		acp.update({ sessionUpdate: "tool_call", toolCallId: "c1", name: "write" });
		expect(acp.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", rawOutput: "denied" })).toEqual([
			{ kind: "tool.call.completed", call_id: "c1", ok: false, output_preview: "denied" },
		]);
	});

	it("does not show one action four times", () => {
		const { acp } = translator();
		const requests = ["pending", "in_progress", "in_progress", "completed"].flatMap((status, index) =>
			acp.update({
				sessionUpdate: index === 0 ? "tool_call" : "tool_call_update",
				toolCallId: "c1",
				name: "read",
				status,
			}),
		);
		expect(requests.filter((event) => event.kind === "tool.call.requested")).toHaveLength(1);
		expect(requests.filter((event) => event.kind === "tool.call.completed")).toHaveLength(1);
	});

	it("does not complete one call twice, however often the agent repeats itself", () => {
		const { acp, skips } = translator();
		acp.update({ sessionUpdate: "tool_call", toolCallId: "c1", name: "read", status: "completed" });
		expect(acp.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })).toEqual([]);
		expect(skips.some((skip) => skip.detail.includes("finished twice"))).toBe(true);
	});

	it("announces a call it first meets as an update, and says it had to", () => {
		// An agent is allowed to send only updates. A room that waited for an opening
		// that never comes would show a completion for a call it never showed being
		// asked for.
		const { acp, skips } = translator();
		const events = acp.update({ sessionUpdate: "tool_call_update", toolCallId: "c9", name: "grep", status: "completed" });

		expect(events.map((event) => event.kind)).toEqual([
			"tool.call.requested",
			"tool.call.completed",
		]);
		expect(skips.some((skip) => skip.detail.includes("first seen as an update"))).toBe(true);
	});

	it("refuses a call with no id, because nothing could ever refer to it", () => {
		const { acp, skips } = translator();
		expect(acp.update({ sessionUpdate: "tool_call", name: "read" })).toEqual([]);
		expect(skips).toEqual([{ reason: "unknown-type", detail: "tool call without toolCallId" }]);
	});

	it("falls back to the title when there is no name, and says (unnamed) when there is neither", () => {
		const { acp } = translator();
		expect(acp.update({ sessionUpdate: "tool_call", toolCallId: "a", title: "Reading a.ts" })[0]).toMatchObject({ tool: "Reading a.ts" });
		expect(acp.update({ sessionUpdate: "tool_call", toolCallId: "b" })[0]).toMatchObject({ tool: "(unnamed)" });
	});

	it("reads output out of content blocks when there is no raw output", () => {
		const { acp } = translator();
		acp.update({ sessionUpdate: "tool_call", toolCallId: "c1", name: "read" });
		const events = acp.update({
			sessionUpdate: "tool_call_update",
			toolCallId: "c1",
			status: "completed",
			content: [{ content: { type: "text", text: "line one" } }, { content: { type: "text", text: "line two" } }],
		});
		expect(events[0]).toMatchObject({ output_preview: "line one line two" });
	});
});

describe("updates this room does not show", () => {
	it("names the known-but-silent ones, and does not call them unknown", () => {
		const { acp, skips } = translator();
		for (const kind of ["plan", "plan_update", "usage_update", "current_mode_update", "compaction_update"]) {
			expect(acp.update({ sessionUpdate: kind }), kind).toEqual([]);
		}
		expect(skips.every((skip) => skip.reason === "no-events")).toBe(true);
	});

	it("still calls a genuinely unknown word unknown", () => {
		// A default that absorbs everything is a translator that cannot tell a new
		// protocol feature from a typo.
		const { acp, skips } = translator();
		expect(acp.update({ sessionUpdate: "telepathy_update" })).toEqual([]);
		expect(skips).toEqual([{ reason: "unknown-type", detail: "telepathy_update" }]);
	});

	it("survives an update with no kind at all", () => {
		const { acp, skips } = translator();
		expect(acp.update({})).toEqual([]);
		expect(skips).toEqual([{ reason: "unknown-type", detail: "(absent)" }]);
	});
});

describe("how the session ends", () => {
	it("counts a ceiling and a rule as completed, because the turn did run", () => {
		for (const reason of ["answered", "budget", "stopped"]) {
			expect(sessionEnded(reason), reason).toEqual({
				kind: "persona.session.ended",
				status: "completed",
			});
		}
	});

	it("calls an interruption stopped, not failed", () => {
		// Somebody's decision is not a fault, and a room that called it one would
		// report a person pressing stop as the machine breaking.
		expect(sessionEnded("interrupted")).toEqual({
			kind: "persona.session.ended",
			status: "stopped",
			reason: "interrupted",
		});
	});

	it("fails with the code and the message when there is one", () => {
		expect(sessionEnded("failed", { code: "acp_transport", message: "socket closed" })).toEqual({
			kind: "persona.session.ended",
			status: "failed",
			reason: "acp_transport: socket closed",
		});
	});

	it("fails with the reason alone when there is no failure to quote", () => {
		expect(sessionEnded("empty")).toMatchObject({ status: "failed", reason: "empty" });
		expect(sessionEnded("refused")).toMatchObject({ status: "failed", reason: "refused" });
	});
});
