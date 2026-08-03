// Translating a host agent's stream into the workspace vocabulary.
//
// The transcripts below are the shape the vendor emits. They are written out in full rather
// than built by a helper, because the whole point of this file is to fail when that shape
// changes, and a helper that constructs the input would keep agreeing with itself.

import { describe, expect, it } from "vitest";

import { HostStreamTranslator, type SkipReason } from "../src/workspace/host-stream.js";

function collect() {
	const skips: Array<{ reason: SkipReason; detail: string }> = [];
	const translator = new HostStreamTranslator({
		onSkip: (reason, detail) => skips.push({ reason, detail }),
	});
	return { translator, skips };
}

describe("a turn the agent takes", () => {
	it("brackets the turn around what happened in it", () => {
		const { translator } = collect();
		const events = translator.translate(
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "Reading the brief." }] },
			}),
		);

		expect(events.map((e) => e.kind)).toEqual([
			"agent.turn.started",
			"agent.thought.streamed",
			"agent.turn.ended",
		]);
	});

	it("numbers turns as they arrive", () => {
		const { translator } = collect();
		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "text", text: "x" }] },
		});

		translator.translate(line);
		const second = translator.translate(line);

		expect(second[0]).toEqual({ kind: "agent.turn.started", turn: 2 });
		expect(translator.turns).toBe(2);
	});

	it("accepts content sent as a bare string", () => {
		// Both shapes are normal from the host.
		const { translator } = collect();
		const events = translator.translate(
			JSON.stringify({ type: "assistant", message: { content: "Just text." } }),
		);

		expect(events).toContainEqual({ kind: "agent.thought.streamed", text: "Just text." });
	});
});

describe("the call id belongs to the host", () => {
	it("carries the host's tool_use id verbatim", () => {
		// This is the one that matters. A gate freezes one specific call by this id, and the
		// hook that refuses a call before it runs is handed the SAME id by the host. Minting
		// our own would give one call two names, and the gate a person approves in the browser
		// would be a different call from the one the hook is holding open on the laptop.
		// Invisible until two calls are in flight, and then it approves the wrong one.
		const { translator } = collect();
		const events = translator.translate(
			JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{ type: "tool_use", id: "toolu_01ABC", name: "Read", input: { file: "a.md" } },
					],
				},
			}),
		);

		expect(events).toContainEqual({
			kind: "tool.call.requested",
			call_id: "toolu_01ABC",
			tool: "Read",
			args_preview: expect.stringContaining("a.md"),
		});
	});

	it("matches a result back to the call by the same id", () => {
		const { translator } = collect();
		const events = translator.translate(
			JSON.stringify({
				type: "user",
				message: {
					content: [{ type: "tool_result", tool_use_id: "toolu_01ABC", content: "done" }],
				},
			}),
		);

		expect(events).toEqual([
			{
				kind: "tool.call.completed",
				call_id: "toolu_01ABC",
				ok: true,
				output_preview: "done",
			},
		]);
	});

	it("refuses to report a call it cannot name", () => {
		// A request with no id can never be gated, correlated or completed. Putting it on the
		// wire leaves a row in the room that no verdict and no result can ever refer to.
		const { translator, skips } = collect();
		const events = translator.translate(
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
			}),
		);

		expect(events.some((e) => e.kind === "tool.call.requested")).toBe(false);
		expect(skips).toContainEqual({ reason: "unknown-type", detail: "tool_use without id" });
	});

	it("treats an absent error flag as success", () => {
		// The host sets the flag when the call failed and omits it when it did not.
		const { translator } = collect();
		const [event] = translator.translate(
			JSON.stringify({
				type: "user",
				message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
			}),
		);

		expect(event).toMatchObject({ ok: true });
	});

	it("reports a failed call as failed", () => {
		const { translator } = collect();
		const [event] = translator.translate(
			JSON.stringify({
				type: "user",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "t1", content: "no such file", is_error: true },
					],
				},
			}),
		);

		expect(event).toMatchObject({ ok: false });
	});
});

describe("what it will not publish", () => {
	it("withholds thinking blocks and says so", () => {
		// The model's private reasoning, in a room the whole team watches. Publishing it is a
		// privacy decision nobody made.
		const { translator, skips } = collect();
		const events = translator.translate(
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "thinking", text: "maybe the config is wrong" }] },
			}),
		);

		expect(events.some((e) => e.kind === "agent.thought.streamed")).toBe(false);
		expect(skips).toContainEqual({ reason: "withheld", detail: "thinking" });
	});

	it("never infers a verdict from the stream", () => {
		// allowed and blocked say what the policy decided, and the policy is decided by the
		// hook before the call runs. A verdict inferred from what happened would report an
		// allow for a call nobody checked.
		const { translator } = collect();
		const events = [
			...translator.translate(
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
				}),
			),
			...translator.translate(
				JSON.stringify({
					type: "user",
					message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] },
				}),
			),
		];

		expect(events.some((e) => e.kind === "tool.call.allowed")).toBe(false);
		expect(events.some((e) => e.kind === "tool.call.blocked")).toBe(false);
	});

	it("redacts before anything reaches the wire", () => {
		// The record is hash chained. A leaked key cannot be edited out afterwards.
		const { translator } = collect();
		const events = translator.translate(
			JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "Bash",
							input: { command: "curl -H 'Authorization: Bearer sk-ant-api03-SECRETVALUE'" },
						},
					],
				},
			}),
		);

		const requested = events.find((e) => e.kind === "tool.call.requested");
		expect(JSON.stringify(requested)).not.toContain("SECRETVALUE");
	});
});

describe("what it does not understand", () => {
	it("never guesses at a line that is not JSON", () => {
		// A half-written line reassembled by hand would put invented content into a record
		// that cannot be corrected afterwards.
		const { translator, skips } = collect();

		expect(translator.translate('{"type":"assis')).toEqual([]);
		expect(skips[0].reason).toBe("unparseable");
	});

	it("reports an unknown message type instead of dropping it", () => {
		// A stream that silently discards what it does not recognise looks exactly like a
		// stream where the agent did nothing. The day the vendor renames a message type is the
		// day a job room goes quiet with nothing in the logs.
		const { translator, skips } = collect();

		expect(translator.translate(JSON.stringify({ type: "checkpoint" }))).toEqual([]);
		expect(skips).toContainEqual({ reason: "unknown-type", detail: "checkpoint" });
	});

	it("reports an unknown content block by name", () => {
		const { translator, skips } = collect();
		translator.translate(
			JSON.stringify({ type: "assistant", message: { content: [{ type: "image" }] } }),
		);

		expect(skips).toContainEqual({ reason: "unknown-type", detail: "content/image" });
	});

	it("ignores blank lines without complaining", () => {
		const { translator, skips } = collect();

		expect(translator.translate("")).toEqual([]);
		expect(translator.translate("   \n")).toEqual([]);
		expect(skips).toEqual([]);
	});
});

describe("how the session ends", () => {
	it("ends completed on a successful result", () => {
		const { translator } = collect();
		const events = translator.translate(
			JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
		);

		expect(events).toEqual([{ kind: "persona.session.ended", status: "completed" }]);
	});

	it("ends failed and says why", () => {
		const { translator } = collect();
		const [event] = translator.translate(
			JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }),
		);

		expect(event).toMatchObject({ kind: "persona.session.ended", status: "failed" });
		expect(event).toHaveProperty("reason");
	});

	it("treats a non-success subtype as a failure even without the error flag", () => {
		// The host sets the two independently, so checking only one lets a failed run be
		// reported to the room as completed.
		const { translator } = collect();
		const [event] = translator.translate(
			JSON.stringify({ type: "result", subtype: "error_during_execution" }),
		);

		expect(event).toMatchObject({ status: "failed" });
	});

	it("does not open a session of its own", () => {
		// Whoever started the job opens it: that is what knows the persona, the version and
		// the machine. A second start here would give the room two.
		const { translator, skips } = collect();
		const events = translator.translate(JSON.stringify({ type: "system", subtype: "init" }));

		expect(events).toEqual([]);
		expect(skips).toContainEqual({ reason: "no-events", detail: "system/init" });
	});
});
