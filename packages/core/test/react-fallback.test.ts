/**
 * E36: the prose fallback, which is what a server that cannot take `tools` drives every run into.
 *
 * Measured live on 2026-09-22 against `deepseek-ai/DeepSeek-R1-Distill-Qwen-14B`, a hosted model that serves
 * chat and refuses the `tools` parameter with a 422. The good half held: the refusal happens once, every later
 * request goes without `tools`, tools DO run and every one of them passes the gate. These tests hold the two
 * halves that did not.
 */
import { describe, it, expect } from "vitest";

import { requestToolCall } from "../src/tool-calling.js";
import type { ToolSpec } from "../src/tools/registry.js";

const OFFERED: ToolSpec[] = [
	{
		name: "read_file",
		description: "Read a file.",
		parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } },
		isReadOnly: true,
		isConcurrencySafe: true,
		gate: () => ({ decision: "allow", reason: "test", class: { writesFiles: false, network: false, destructive: false, escapesWorkspace: false } }),
		execute: async () => "",
	} as unknown as ToolSpec,
];

/**
 * A server that refuses `tools` exactly as the measured one does, and then answers the fallback with `reply`.
 *
 * The 422 on the first request is what makes this the fallback path and not the native one, so the test drives
 * the same seam the live run did rather than calling the fallback directly.
 */
function refusesTools(reply: string): { fetchImpl: typeof fetch; sent: string[] } {
	const sent: string[] = [];
	const fetchImpl = (async (_url: string, init?: { body?: string }) => {
		const body = JSON.parse(init?.body ?? "{}");
		sent.push(body.tools ? "with tools" : "without tools");
		if (body.tools) {
			return {
				ok: false,
				status: 422,
				text: async () => '{"error":{"error_type":"UNSUPPORTED_OPENAI_PARAMS","message":"The following parameters are not supported for this model: tools"}}',
			};
		}
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reply } }] }) };
	}) as unknown as typeof fetch;
	return { fetchImpl, sent };
}

const ask = (fetchImpl: typeof fetch) =>
	requestToolCall({ endpoint: "http://x/v1", model: "m", fetchImpl }, [{ role: "user", content: "help" }], OFFERED);

describe("the prose fallback (E36)", () => {
	it("goes to the fallback once the server refuses tools, and not before", async () => {
		const { fetchImpl, sent } = refusesTools('{"thought":"reading it","tool":"read_file","args":{"path":"a.md"}}');
		const r = await ask(fetchImpl);

		expect(r.usedFallback).toBe(true);
		expect(sent[0]).toBe("with tools");
		expect(sent.slice(1).every((s) => s === "without tools")).toBe(true);
		expect(r.toolCalls).toHaveLength(1);
		expect(r.toolCalls[0]?.name).toBe("read_file");
	});

	it("never hands its own envelope to the reader as the answer", async () => {
		// The shape measured live: a JSON object with args and no `tool`, returned as the persona's reply.
		const { fetchImpl } = refusesTools('{"args":{"acceleration":0.8,"friction":0.12,"gravity":9.8}}');
		const r = await ask(fetchImpl);

		expect(r.toolCalls).toHaveLength(0);
		expect(r.text).not.toContain("acceleration");
		expect(r.text).not.toContain("{");
	});

	it("keeps the thought, which is the only part of the envelope meant for a person", async () => {
		const { fetchImpl } = refusesTools('{"thought":"I need the file first."}');
		const r = await ask(fetchImpl);

		expect(r.text).toBe("I need the file first.");
		expect(r.toolCalls).toHaveLength(0);
	});

	it("refuses a tool it was not offered, and says which, the way readDialect does", async () => {
		const { fetchImpl } = refusesTools('{"thought":"","tool":"exfiltrate","args":{"to":"evil.example"}}');
		const r = await ask(fetchImpl);

		expect(r.toolCalls).toHaveLength(0);
		// Reported rather than swallowed: this field exists so a deployment missing its parser is visible.
		expect(r.unknownTools).toEqual(["exfiltrate"]);
	});
});
