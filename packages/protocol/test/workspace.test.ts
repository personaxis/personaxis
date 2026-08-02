import { describe, expect, it } from "vitest";

import {
	BROWSER_MSG_TYPES,
	isWireVersionSupported,
	MAX_INTERVENTION_LENGTH,
	MIN_SUPPORTED_WIRE_VERSION,
	parseBrowserMsg,
	parseServerMsg,
	WIRE_EVENT_KINDS,
	WIRE_VERSION,
	wireIncompatibleError,
	type BrowserMsg,
} from "../src/workspace.js";

describe("the browser message boundary", () => {
	// This list is a security boundary. A browser cannot start a job, cannot
	// reach a shell and cannot assign a sequence number, and the way that stays
	// true is that anything outside the list is refused rather than ignored.
	it("accepts exactly the nine message types and nothing else", () => {
		expect([...BROWSER_MSG_TYPES].sort()).toEqual(
			[
				"ack",
				"gate.approve",
				"gate.deny",
				"intervention.enqueue",
				"pause",
				"resume",
				"steering.request",
				"steering.release",
				"stop",
			].sort(),
		);
	});

	it.each([
		"job.start",
		"job.assign",
		"policy.push",
		"event",
		"exec",
		"__proto__",
		"",
	])("refuses %s", (type) => {
		const result = parseBrowserMsg({ type });
		expect(result.ok).toBe(false);
	});

	it("says which type it did not recognise, so a probe is distinguishable from a bug", () => {
		const result = parseBrowserMsg({ type: "job.start" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("job.start");
	});

	it.each([null, undefined, 42, "pause", [], [{ type: "pause" }]])(
		"refuses a frame that is not an object: %s",
		(frame) => {
			expect(parseBrowserMsg(frame).ok).toBe(false);
		},
	);

	it("never throws, because a malformed frame is an ordinary event on a socket", () => {
		const hostile: unknown[] = [
			{ type: "gate.approve" },
			{ type: "ack", seq: "1" },
			{ type: "ack", seq: -1 },
			{ type: "ack", seq: 1.5 },
			{ type: "intervention.enqueue" },
			{ type: "intervention.enqueue", body: 123 },
			Object.create(null),
			{ get type() {
				throw new Error("boom");
			} },
		];
		for (const frame of hostile) {
			expect(() => parseBrowserMsg(frame)).not.toThrow();
		}
	});
});

describe("intervention bodies", () => {
	it("accepts one within the limit", () => {
		const result = parseBrowserMsg({ type: "intervention.enqueue", body: "stop and summarise" });
		expect(result).toEqual({
			ok: true,
			value: { type: "intervention.enqueue", body: "stop and summarise" },
		});
	});

	it("refuses an empty one rather than queueing a no-op", () => {
		expect(parseBrowserMsg({ type: "intervention.enqueue", body: "" }).ok).toBe(false);
	});

	it("refuses one over the limit and says by how much", () => {
		const body = "x".repeat(MAX_INTERVENTION_LENGTH + 1);
		const result = parseBrowserMsg({ type: "intervention.enqueue", body });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain(String(MAX_INTERVENTION_LENGTH));
			expect(result.error).toContain(String(body.length));
		}
	});

	it("accepts exactly the limit, so the boundary is not off by one", () => {
		const body = "x".repeat(MAX_INTERVENTION_LENGTH);
		expect(parseBrowserMsg({ type: "intervention.enqueue", body }).ok).toBe(true);
	});
});

describe("ack", () => {
	it("accepts zero, which is what a client sends before it has seen anything", () => {
		expect(parseBrowserMsg({ type: "ack", seq: 0 })).toEqual({
			ok: true,
			value: { type: "ack", seq: 0 },
		});
	});
});

describe("the event vocabulary", () => {
	it("lists every kind exactly once", () => {
		expect(new Set(WIRE_EVENT_KINDS).size).toBe(WIRE_EVENT_KINDS.length);
	});

	it("carries the twenty events the surface is built on", () => {
		// A kind added to the type without being added here would let the engine
		// adapter skip it silently, which is the one failure this list prevents.
		expect(WIRE_EVENT_KINDS).toHaveLength(20);
	});
});

describe("wire version negotiation", () => {
	it("accepts the current version", () => {
		expect(isWireVersionSupported(WIRE_VERSION)).toBe(true);
	});

	it("refuses a version from the future, which this server cannot interpret", () => {
		expect(isWireVersionSupported(WIRE_VERSION + 1)).toBe(false);
	});

	it("refuses anything below the floor", () => {
		expect(isWireVersionSupported(MIN_SUPPORTED_WIRE_VERSION - 1)).toBe(false);
	});

	it.each([null, undefined, "1", 1.5, Number.NaN])("refuses %s", (value) => {
		expect(isWireVersionSupported(value)).toBe(false);
	});

	it("refuses with a message that names the versions and the fix", () => {
		// An operator should learn what to do from the error, not from a support
		// thread.
		const error = wireIncompatibleError(99);
		expect(error.code).toBe("wire_incompatible");
		expect(error.message).toContain(String(WIRE_VERSION));
		expect(error.message).toContain("99");
		expect(error.message).toContain("npm i -g personaxis");
	});
});

describe("the module's portability", () => {
	it("parses without any node built-in, since it runs in a Worker and a browser", async () => {
		// Importing it here would fail at resolution time if it reached for
		// node:crypto or node:net the way the JSON-RPC transport next door does.
		const module = await import("../src/workspace.js");
		expect(module.WIRE_VERSION).toBe(1);
	});
});

describe("the server message boundary", () => {
	// The symmetric half of the browser boundary. A client that trusts whatever
	// JSON arrives on its socket builds its interface out of whatever it got,
	// and a proxy, an extension or a stale deployment can put a frame there.
	const event = { job_id: "job_1", seq: 1, ts: "2026-08-02T10:00:00.000Z", source: "daemon", kind: "agent.turn.started", turn: 1 };

	it("reads a gap frame off the wire, as the string a socket delivers", () => {
		const result = parseServerMsg(JSON.stringify({ type: "sync.gap", events: [event] }));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toMatchObject({ type: "sync.gap" });
	});

	it("reads an already parsed value too", () => {
		expect(parseServerMsg({ type: "sync.gap", events: [] }).ok).toBe(true);
	});

	it("refuses an event with no assigned sequence", () => {
		// seq 0 means "not yet assigned". A reducer that accepted it would hold a
		// permanent gap at the head of the job.
		const result = parseServerMsg({ type: "sync.gap", events: [{ ...event, seq: 0 }] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("seq");
	});

	it.each([["job_id"], ["kind"]])("refuses an event with no %s", (field) => {
		const broken = { ...event, [field]: undefined };
		const result = parseServerMsg({ type: "sync.gap", events: [broken] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(field);
	});

	it("requires steering on a snapshot", () => {
		// Without it a client cannot say whether anyone is driving, which reads
		// as "nobody" and lets two people act at once.
		const result = parseServerMsg({ type: "sync.snapshot", events: [], presence: [] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("steering");
	});

	it("names an unknown type rather than lumping it into malformed", () => {
		const result = parseServerMsg({ type: "sync.telepathy" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("sync.telepathy");
	});

	it.each([["not json at all"], ['{"broken":'], ["null"], ["[]"]])(
		"never throws on %s",
		(raw) => {
			// A malformed frame is an ordinary event on a long-lived socket. An
			// uncaught exception in onmessage takes the view down with it.
			expect(() => parseServerMsg(raw)).not.toThrow();
			expect(parseServerMsg(raw).ok).toBe(false);
		},
	);

	it("carries an error frame through with its code", () => {
		const result = parseServerMsg({ type: "error", code: "forbidden", message: "no access" });
		expect(result.ok).toBe(true);
		if (result.ok && result.value.type === "error") expect(result.value.code).toBe("forbidden");
	});
});

// Type-level checks: these fail the build rather than the test run.
const _pause: BrowserMsg = { type: "pause" };
void _pause;
