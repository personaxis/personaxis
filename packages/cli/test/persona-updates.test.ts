/**
 * What a client sees while our persona works, and what it is asked to permit.
 *
 * The mirror of `acp-wire.test.ts`. Both translations sit either side of one
 * vocabulary, so the interesting assertions are about what does NOT cross: the
 * persona's reasoning, and the events that mean nothing outside a workspace.
 */

import { describe, expect, it } from "vitest";

import {
	permissionGranted,
	permissionRequest,
	servedUpdate,
} from "../src/workspace/persona-updates.js";

describe("what the client sees", () => {
	it("sends what the persona said", () => {
		expect(servedUpdate({ kind: "agent.thought.streamed", text: "done" })).toEqual({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "done" },
		});
	});

	it("sends nothing for an empty message rather than an empty chunk", () => {
		expect(servedUpdate({ kind: "agent.thought.streamed", text: "" })).toBeUndefined();
	});

	it("opens a tool call with a name as well as a title", () => {
		// A client's own policy matches on the name, and we are on the receiving end of
		// that reasoning here: handing an editor only the human sentence is exactly the
		// mistake `A3` had to correct in the other direction.
		const update = servedUpdate({
			kind: "tool.call.requested",
			call_id: "c1",
			tool: "Bash",
			args_preview: "ls",
		});

		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "c1",
			name: "Bash",
			title: "Bash",
			rawInput: "ls",
		});
	});

	it("closes one, and says whether it worked", () => {
		expect(servedUpdate({ kind: "tool.call.completed", call_id: "c1", ok: true })).toMatchObject({
			sessionUpdate: "tool_call_update",
			status: "completed",
		});
		expect(servedUpdate({ kind: "tool.call.completed", call_id: "c1", ok: false })).toMatchObject({
			status: "failed",
		});
	});

	it("reports a refused call as a call that finished badly, not as silence", () => {
		// Silence would leave a client showing a tool call that never finishes.
		const update = servedUpdate({
			kind: "tool.call.blocked",
			call_id: "c1",
			rule: "no_network",
			reason: "this persona does not reach the internet",
		});

		expect(update).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
		expect(String((update as { rawOutput: string }).rawOutput)).toContain("no_network");
	});
});

describe("what stays on this machine", () => {
	it("sends nothing that only means something inside a workspace", () => {
		// Gates, artifacts, steering and band crossings are facts about a workspace run.
		// A persona embedded in somebody's editor has no workspace, and sending them
		// would put events in a session that mean nothing there.
		for (const kind of [
			"gate.opened",
			"gate.resolved",
			"artifact.created",
			"steering.granted",
			"band.crossed",
			"envelope.clamped",
			"persona.session.started",
		]) {
			expect(servedUpdate({ kind }), kind).toBeUndefined();
		}
	});

	it("has no mapping that sends the persona's private reasoning", () => {
		// The rule the other direction follows, and it matters more here: it is our
		// persona's reasoning and somebody else's screen.
		const reasoning = servedUpdate({ kind: "agent.thinking", text: "maybe I should rm -rf" });
		expect(reasoning).toBeUndefined();
	});
});

describe("asking the person on the other end", () => {
	const call = { name: "Bash", args: { command: "rm -rf /" }, id: "c1" };

	it("says what the call is and why it is being asked", () => {
		const request = permissionRequest("s1", call, "destructive command");
		const tool = (request as { toolCall: Record<string, unknown> }).toolCall;

		expect(tool["name"]).toBe("Bash");
		expect(String(tool["title"])).toContain("destructive command");
		expect(tool["rawInput"]).toEqual({ command: "rm -rf /" });
	});

	it("offers once, never always", () => {
		// A persona's policy is recompiled per run, so `allow_always` would be a promise
		// about future runs that nothing here can keep.
		const options = (permissionRequest("s1", call, "") as { options: { kind: string }[] }).options;
		expect(options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);
	});

	it("falls back to the bare name when there is no reason to give", () => {
		const tool = (permissionRequest("s1", call, "") as { toolCall: { title: string } }).toolCall;
		expect(tool.title).toBe("Bash");
	});
});

describe("reading the answer", () => {
	it("is a yes only when they selected our allow", () => {
		expect(permissionGranted({ outcome: { outcome: "selected", optionId: "allow" } })).toBe(true);
	});

	it("is a no for everything else, including a word this build does not know", () => {
		// A permission answer that cannot be read is not a yes. Defaulting the other way
		// would make an unrecognised reply into consent.
		expect(permissionGranted({ outcome: { outcome: "selected", optionId: "reject" } })).toBe(false);
		expect(permissionGranted({ outcome: { outcome: "cancelled" } })).toBe(false);
		expect(permissionGranted({ outcome: { outcome: "telepathy" } })).toBe(false);
		expect(permissionGranted({})).toBe(false);
		expect(permissionGranted(undefined)).toBe(false);
	});
});
