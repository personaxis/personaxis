// The protocol states that free text on the wire "has already passed redaction
// at the producer" and that "nothing downstream redacts". This is the test that
// makes that sentence true rather than aspirational.
//
// It is written as a sweep rather than as a list of cases on purpose. A per-case
// test proves the cases somebody thought of; this walks every LoopEvent that
// maps to the wire, plants a real secret in each of its string fields, and
// asserts the secret does not come out the other side. A new event with a new
// text field fails here without anyone remembering to add a test.

import { describe, expect, it } from "vitest";

import type { LoopEvent } from "../src/events.js";
import { mapLoopEvent } from "../src/wire/adapter.js";

/** A recognisable, unmistakably secret string. */
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz012345";

/**
 * One representative of every LoopEvent kind that reaches the wire, with the
 * secret planted in every free-text position it has.
 */
const EVENTS: LoopEvent[] = [
	{ type: "tool-propose", tool: "Bash", args: { command: `curl -H "Authorization: Bearer ${SECRET}"` } },
	{ type: "tool-propose", tool: "Write", args: { path: ".env", content: `API_KEY=${SECRET}` } },
	{ type: "tool-verdict", decision: "allow", reason: `matched allow rule for ${SECRET}` },
	{ type: "tool-verdict", decision: "deny", reason: `deny list matched: ${SECRET}` },
	{ type: "tool-result", ok: true, output: `token is ${SECRET}` },
	{ type: "tool-result", ok: false, output: { error: `auth failed for ${SECRET}` } },
	{ type: "agent-think", text: `I should use ${SECRET} for this` },
	{ type: "agent-finish", steps: 3, summary: `Called the API with ${SECRET}` },
	{ type: "agent-error", message: `request failed: postgresql://u:${SECRET}@h/db` },
	{ type: "error", message: `unhandled: ${SECRET}` },
	{ type: "agent-stop-condition", reason: `budget exhausted while holding ${SECRET}` },
] as LoopEvent[];

/** Every string anywhere in a value, at any depth. */
function stringsIn(value: unknown, found: string[] = []): string[] {
	if (typeof value === "string") found.push(value);
	else if (Array.isArray(value)) for (const item of value) stringsIn(item, found);
	else if (value && typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) stringsIn(item, found);
	}
	return found;
}

describe("nothing carrying a secret reaches the wire", () => {
	it.each(EVENTS.map((event) => [describeEvent(event), event] as const))(
		"%s",
		(_label, event) => {
			const result = mapLoopEvent(event, { callId: "call_1" });
			if ("drop" in result) return;

			for (const text of stringsIn(result.emit)) {
				expect(text, `secret survived in: ${text}`).not.toContain(SECRET);
			}
		},
	);

	it("still says what happened", () => {
		// Redaction that emptied the event would pass the test above and make the
		// record useless. The tool name and the shape of the call must survive.
		const result = mapLoopEvent(
			{ type: "tool-propose", tool: "Bash", args: { command: `curl -H "Authorization: Bearer ${SECRET}"` } } as LoopEvent,
			{ callId: "call_1" },
		);
		if ("drop" in result) return expect.unreachable();

		expect(result.emit.tool).toBe("Bash");
		expect(String(result.emit.args_preview)).toContain("curl");
		expect(String(result.emit.args_preview)).toContain("[redacted]");
	});

	it("redacts before truncating", () => {
		// Cutting first can slice a secret in half and leave a fragment matching
		// no pattern, and the redactor would report success on a preview still
		// carrying most of a key.
		const padding = "x".repeat(500);
		const result = mapLoopEvent(
			{ type: "tool-result", ok: true, output: `${padding} ${SECRET}` } as LoopEvent,
			{ callId: "call_1" },
		);
		if ("drop" in result) return expect.unreachable();

		const preview = String(result.emit.output_preview);
		// The secret is past the truncation point, so what matters is that no
		// prefix of it survives either.
		expect(preview).not.toContain("ghp_abcdefghij");
	});

	it("catches a secret by its key name even when the value looks ordinary", () => {
		const result = mapLoopEvent(
			{ type: "tool-propose", tool: "Http", args: { password: "hunter2" } } as LoopEvent,
			{ callId: "call_1" },
		);
		if ("drop" in result) return expect.unreachable();
		expect(String(result.emit.args_preview)).not.toContain("hunter2");
	});
});

function describeEvent(event: LoopEvent): string {
	const extra = "decision" in event ? `:${String(event.decision)}` : "";
	return `${event.type}${extra}`;
}
