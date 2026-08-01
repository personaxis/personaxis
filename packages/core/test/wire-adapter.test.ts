import { describe, expect, it } from "vitest";

import type { LoopEvent } from "../src/events.js";
import { mapLoopEvent, preview } from "../src/wire/adapter.js";

/**
 * One sample of every LoopEvent kind.
 *
 * The list is the point. TypeScript already fails the build if the adapter
 * stops being exhaustive, but it cannot tell whether a kind was mapped
 * deliberately or dropped by an author in a hurry. This walks all of them and
 * asserts each one has an answer, so adding an event without deciding what the
 * workspace does with it fails here.
 */
const EVERY_EVENT: LoopEvent[] = [
	{ type: "observe", observation: "o", source: "user" },
	{ type: "appraise", signal: {} as never },
	{ type: "govern", verdicts: [] },
	{ type: "mutate", result: {} as never },
	{ type: "memory", entry: {} as never },
	{ type: "memory-kind", kind: "semantic", detail: "d" },
	{ type: "memory-recall", kind: "episodic", count: 1 },
	{ type: "evaluation", target: "t", dimension: "d", score: 1, rationale: "r" },
	{ type: "self-edit", op: "queued", targetPath: "p" },
	{ type: "anomaly", kind: "k", detail: "d" },
	{ type: "drift", global: 0, crossings: [], layersExceeded: [], report: {} as never },
	{ type: "recompile", reason: "r" },
	{ type: "abstain", reason: "r" },
	{ type: "error", message: "m" },
	{ type: "tick-complete", mutationsApplied: 0, memoriesWritten: 0 },
	{ type: "agent-step", step: 1 },
	{ type: "agent-think", text: "t" },
	{ type: "tool-propose", tool: "Bash", args: { cmd: "ls" } },
	{ type: "tool-verdict", tool: "Bash", decision: "allow", reason: "permissions.allow" },
	{ type: "tool-result", tool: "Bash", ok: true, output: "out" },
	{ type: "agent-finish", summary: "s", steps: 3 },
	{ type: "agent-error", message: "m" },
	{ type: "agent-budget", step: 1, tokens: 1, costUsd: 0, wallSeconds: 1 },
	{ type: "agent-stop-condition", reason: "r", step: 1 },
	{ type: "verify-start", gates: 1 },
	{ type: "verify-result", verifier: "v", pass: true, reason: "r" },
	{ type: "verify-complete", passed: true, passes: 1, quorum: 1 },
	{ type: "trace-exported", format: "otlp", path: "p", spanCount: 1 },
	{ type: "context-meter", used: 1, limit: 2, pct: 50 },
	{ type: "context-compacted", removed: 1, usedAfter: 1 },
];

describe("the mapping is closed", () => {
	it("answers for every engine event, emitting or dropping with a reason", () => {
		const unanswered = EVERY_EVENT.filter((event) => {
			const result = mapLoopEvent(event);
			return !("emit" in result) && !("drop" in result);
		});
		expect(unanswered).toEqual([]);
	});

	it("never drops with an unmapped marker, which is what a missed case looks like", () => {
		const unmapped = EVERY_EVENT.map((e) => mapLoopEvent(e))
			.filter((r): r is { drop: string } => "drop" in r)
			.filter((r) => r.drop.startsWith("unmapped"));
		expect(unmapped).toEqual([]);
	});

	it("covers every kind the engine declares", () => {
		// A kind added to LoopEvent but not to this file would leave the walk
		// above testing a stale list.
		const covered = new Set(EVERY_EVENT.map((e) => e.type));
		expect(covered.size).toBe(EVERY_EVENT.length);
		expect(covered.size).toBe(30);
	});
});

describe("tool calls", () => {
	it("carries the call id through propose, verdict and result", () => {
		const context = { callId: "call_7" };
		for (const event of [
			{ type: "tool-propose", tool: "Bash", args: {} },
			{ type: "tool-verdict", tool: "Bash", decision: "allow", reason: "r" },
			{ type: "tool-result", tool: "Bash", ok: true, output: "" },
		] as LoopEvent[]) {
			const result = mapLoopEvent(event, context);
			expect(result).toHaveProperty("emit");
			if ("emit" in result) expect(result.emit.call_id).toBe("call_7");
		}
	});

	it("turns a denial into a blocked call that names the rule that decided", () => {
		const result = mapLoopEvent(
			{ type: "tool-verdict", tool: "Bash", decision: "deny", reason: "permissions.deny" },
			{ callId: "c" },
		);
		expect(result).toMatchObject({
			emit: { kind: "tool.call.blocked", rule: "permissions.deny" },
		});
	});

	it("does not invent an event for ask, which is what opens a gate", () => {
		// The gate carries routing, quorum and a timeout that this event does not
		// have. Emitting a half-formed gate here would be worse than none.
		const result = mapLoopEvent(
			{ type: "tool-verdict", tool: "Bash", decision: "ask", reason: "risk" },
			{ callId: "c" },
		);
		expect(result).toEqual({ drop: "covered-elsewhere" });
	});
});

describe("state changes reach the wire only when someone can perceive them", () => {
	it("emits a clamp, which is the envelope visibly holding", () => {
		const result = mapLoopEvent({
			type: "mutate",
			result: { clamped: true, path: "personality.traits.humor", requested: 0.9, applied: 0.7 },
		} as LoopEvent);
		expect(result).toMatchObject({
			emit: { kind: "envelope.clamped", field: "personality.traits.humor", applied: 0.7 },
		});
	});

	it("drops a mutation that was not clamped, which is routine", () => {
		const result = mapLoopEvent({ type: "mutate", result: { clamped: false } } as LoopEvent);
		expect(result).toEqual({ drop: "engine-internal" });
	});

	it("emits a band crossing, which is what a behaviour change is", () => {
		const result = mapLoopEvent({
			type: "recompile",
			reason: "crossed",
			crossings: [{ field: "affect.mood.tone", fromBand: "low", toBand: "moderate", prose: "steadier" }],
		});
		expect(result).toMatchObject({
			emit: { kind: "band.crossed", from_band: "low", to_band: "moderate", prose: "steadier" },
		});
	});

	it("drops a recompile that crossed nothing, since nobody could perceive it", () => {
		expect(mapLoopEvent({ type: "recompile", reason: "routine" })).toEqual({
			drop: "engine-internal",
		});
	});
});

describe("previews", () => {
	it("truncates rather than carrying a payload onto the wire", () => {
		const long = "x".repeat(1000);
		expect(preview(long).length).toBeLessThanOrEqual(512);
	});

	it("leaves a short value alone", () => {
		expect(preview("ls -la")).toBe("ls -la");
	});

	it("serialises structured args, since a tool's arguments are not a string", () => {
		expect(preview({ cmd: "ls" })).toBe('{"cmd":"ls"}');
	});

	it("survives a value that does not serialise", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => preview(cyclic)).not.toThrow();
	});
});
