/**
 * A tool call that does not match its schema goes back to the model, and the turn goes on.
 *
 * Found on 2026-09-11 in a real service run (E52): the model called `edit_file` without `path`,
 * the call reached the write gate as `undefined`, `pathEscapesWorkspace` threw on it, and the
 * whole step died as "agent error: Cannot read properties of undefined". `validateToolArgs`
 * existed, said it ran before the gate, and had no caller.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compile, DEFAULT_POLICY, PersonaAgent, policyFromPersona, type LoopEvent } from "../src/index.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-malformed-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A model that makes these calls in order, one per turn, and sees what came back. */
function model(calls: Array<{ name: string; args: object }>, seen: string[]): typeof fetch {
	let turn = 0;
	return (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		const body = JSON.parse(init?.body ?? "{}") as { messages?: Array<{ role: string; content?: string }> };
		const last = body.messages?.at(-1);
		if (last?.role === "tool" && typeof last.content === "string") seen.push(last.content);
		const call = calls[Math.min(turn, calls.length - 1)]!;
		turn += 1;
		return {
			ok: true,
			status: 200,
			json: async () => ({
				choices: [{ message: { content: "", tool_calls: [{ id: `c${turn}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }],
			}),
		};
	}) as unknown as typeof fetch;
}

function agent(fetchImpl: typeof fetch, events: LoopEvent[]) {
	const posture = { sandbox: "workspace-write", approval: "never" } as const;
	const a = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, ...posture },
		capability: compile(policyFromPersona({ permissions: posture }, { personaVersionId: "pv_malformed" })),
		maxSteps: 5,
	});
	a.bus.on((e) => events.push(e));
	return a;
}

describe("a call that does not match its tool's arguments", () => {
	it("goes back to the model as an error it can fix, and the retry writes the file", async () => {
		const seen: string[] = [];
		const events: LoopEvent[] = [];
		const run = await agent(
			model(
				[
					{ name: "write_file", args: { file_path: "notes.md", content: "hello" } },
					{ name: "write_file", args: { path: "notes.md", content: "hello" } },
					{ name: "finish", args: { summary: "done" } },
				],
				seen,
			),
			events,
		).run("write notes.md");

		expect(seen[0]).toContain("missing required arg 'path'");
		expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("hello");
		expect(run.finished).toBe(true);
		// Nothing judged the malformed call: the first verdict is the retry's.
		expect(events.filter((e) => e.type === "tool-verdict")).toHaveLength(1);
	});

	it("says which argument has the wrong type", async () => {
		const seen: string[] = [];
		await agent(
			model(
				[
					{ name: "write_file", args: { path: 42, content: "x" } },
					{ name: "finish", args: { summary: "done" } },
				],
				seen,
			),
			[],
		).run("write");
		expect(seen[0]).toContain("arg 'path' must be string");
		expect(existsSync(join(dir, "42"))).toBe(false);
	});

	it("leaves an argument too many alone, as it always did", async () => {
		const seen: string[] = [];
		await agent(
			model(
				[
					{ name: "write_file", args: { path: "notes.md", content: "hello", encoding: "utf8" } },
					{ name: "finish", args: { summary: "done" } },
				],
				seen,
			),
			[],
		).run("write");
		expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("hello");
	});
});
