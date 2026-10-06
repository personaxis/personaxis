/**
 * E137: a call cut at the token ceiling that the provider hands over as complete.
 *
 * Read raw on 2026-09-24 (Qwen3.5-9B on HuggingFace's router, a streamed write_file with a ceiling it could not
 * fit in): both providers said `finish: tool_calls` and sent arguments that PARSE. together dropped the cut
 * argument; deepinfra closed the string itself. The only fact that does not lie is the usage, which reports every
 * token of the ceiling spent. These streams have the shapes read that day.
 */
import { describe, expect, it } from "vitest";

import { requestToolCall, type ChatMessage } from "../src/tool-calling.js";
import type { ToolSpec } from "../src/tools/registry.js";

const tool = {
	name: "write_file",
	description: "Write a file.",
	parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
} as unknown as ToolSpec;

const CONVERSATION: ChatMessage[] = [
	{ role: "system", content: "You build browser games." },
	{ role: "user", content: "Write the whole game as game.html." },
];

/** A provider that streams these tool calls, says `finish`, and reports this many completion tokens. */
function streaming(calls: Array<{ name: string; arguments: string }>, finish: string, completionTokens: number) {
	const frames = [
		...calls.map((call, index) => ({ choices: [{ delta: { role: "assistant", tool_calls: [{ index, id: `c${index}`, function: call }] } }] })),
		{ choices: [{ delta: {}, finish_reason: finish }] },
		{ choices: [], usage: { prompt_tokens: 331, completion_tokens: completionTokens, total_tokens: 331 + completionTokens } },
	];
	const text = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
	return (async () => ({
		ok: true,
		status: 200,
		headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
		body: (async function* () {
			yield new TextEncoder().encode(text);
		})(),
	})) as unknown as typeof fetch;
}

const ask = (fetchImpl: typeof fetch, maxTokens = 1500) =>
	requestToolCall({ endpoint: "http://cut-at-cap.invalid/v1", model: "qwen3.5-9b", maxTokens, fetchImpl, onDelta: () => {} }, CONVERSATION, [tool]);

describe("a call cut at the ceiling is a cut call, whatever the provider says (E137)", () => {
	it("together's shape: the cut argument dropped, valid JSON, finish tool_calls, every token spent", async () => {
		const reply = await ask(streaming([{ name: "write_file", arguments: '{"path": "game.html"}' }], "tool_calls", 1500));
		expect(reply.toolCalls[0]!.truncated).toBe(true);
	});

	it("deepinfra's shape: the string closed by the provider, half a stylesheet in content, every token spent", async () => {
		const half = JSON.stringify({ path: "game.html", content: "<!DOCTYPE html>\n<html>\n<head>\n<style>\n  .hidden {\n    display: none !important;\n  }" });
		const reply = await ask(streaming([{ name: "write_file", arguments: half }], "tool_calls", 1500));
		expect(reply.toolCalls[0]!.truncated).toBe(true);
	});

	it("a provider that says length is believed too", async () => {
		const reply = await ask(streaming([{ name: "write_file", arguments: '{"path": "game.html"}' }], "length", 900));
		expect(reply.toolCalls[0]!.truncated).toBe(true);
	});

	it("only the last call is the cut one: the calls before it were finished before the ceiling", async () => {
		const reply = await ask(
			streaming(
				[
					{ name: "write_file", arguments: '{"path": "README.md", "content": "# Frog"}' },
					{ name: "write_file", arguments: '{"path": "game.html"}' },
				],
				"tool_calls",
				1500,
			),
		);
		expect(reply.toolCalls.map((call) => call.truncated ?? false)).toEqual([false, true]);
	});

	it("a finished call under the ceiling is left alone", async () => {
		const whole = JSON.stringify({ path: "game.html", content: "<!DOCTYPE html><html></html>" });
		const reply = await ask(streaming([{ name: "write_file", arguments: whole }], "tool_calls", 40));
		expect(reply.toolCalls[0]!.truncated).toBeUndefined();
	});
});
