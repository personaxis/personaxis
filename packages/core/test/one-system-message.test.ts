/**
 * E136: a model whose chat template takes one system message, first, works with the loop.
 *
 * Measured 2026-09-24 with `Qwen/Qwen3.5-9B` on HuggingFace's router: the loop sends several system messages, that
 * template refuses them with a 400, and every turn fell back to prose. These use two fake providers: one with that
 * rule and one that takes several system messages, which must receive them untouched, because the first system
 * message is the prefix a provider caches and folding them always would put the turn's scope inside it. What is
 * checked is what each provider RECEIVED, which is the only thing that matters about the shaping.
 */
import { describe, expect, it } from "vitest";

import { requestToolCall, type ChatMessage } from "../src/tool-calling.js";
import type { ToolSpec } from "../src/tools/registry.js";

const tool = {
	name: "read_file",
	description: "Read a file.",
	parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } },
} as unknown as ToolSpec;

const CONVERSATION: ChatMessage[] = [
	{ role: "system", content: "You are Gamewright." },
	{ role: "system", content: "# Right now\nsandbox: workspace-write" },
	{ role: "user", content: "Fix the game." },
	{ role: "assistant", content: "Looking." },
	{ role: "system", content: "[runtime:task-list] 1. read the game" },
];

/** A provider, the requests it received, and whether it takes only one system message, first. */
function provider(oneSystemOnly: boolean) {
	const received: ChatMessage[][] = [];
	const fetchImpl = (async (_url: string, init?: { body?: string }) => {
		const messages = (JSON.parse(init?.body ?? "{}") as { messages: ChatMessage[] }).messages;
		received.push(messages);
		const refused = oneSystemOnly && messages.some((message, index) => message.role === "system" && index > 0);
		if (refused) return { ok: false, status: 400, text: async () => '{"error":{"message":"Input validation error"}}', json: async () => ({}) };
		const message = { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"game.html"}' } }] };
		return { ok: true, status: 200, json: async () => ({ choices: [{ message, finish_reason: "tool_calls" }] }) };
	}) as unknown as typeof fetch;
	return { fetchImpl, received };
}

describe("one system message, first, when the template takes no other shape (E136)", () => {
	it("a refusing provider gets native tool calls after one retry, and the next request is shaped the first time", async () => {
		const { fetchImpl, received } = provider(true);
		const cfg = { endpoint: "http://one-system.invalid/v1", model: "qwen3.5-9b", fetchImpl };
		const first = await requestToolCall(cfg, CONVERSATION, [tool]);
		expect(first.usedFallback).toBe(false);
		expect(first.toolCalls.map((call) => call.name)).toEqual(["read_file"]);
		expect(received).toHaveLength(2);

		await requestToolCall(cfg, CONVERSATION, [tool]);
		expect(received).toHaveLength(3);
		expect(received[2]!.filter((message) => message.role === "system")).toHaveLength(1);
	});

	it("the retry folds the leading system messages into one and turns a later one into a message that keeps its author", async () => {
		const { fetchImpl, received } = provider(true);
		await requestToolCall({ endpoint: "http://one-system-shape.invalid/v1", model: "qwen3.5-9b", fetchImpl }, CONVERSATION, [tool]);
		const shaped = received[1]!;
		expect(shaped.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
		expect(shaped[0]!.content).toBe("You are Gamewright.\n\n# Right now\nsandbox: workspace-write");
		expect(shaped[3]!.content).toBe("[runtime:task-list] 1. read the game");
	});

	it("streamed, a refusal comes back 200 with the error inside the stream, and is retried the same way", async () => {
		// Read on 2026-09-24 from the raw body with its headers (provider deepinfra, via HuggingFace's router).
		const received: ChatMessage[][] = [];
		const stream = (text: string) => ({
			ok: true,
			status: 200,
			headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
			body: (async function* () {
				yield new TextEncoder().encode(text);
			})(),
		});
		const call = JSON.stringify({ choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"game.html"}' } }] } }] });
		const done = JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
		const fetchImpl = (async (_url: string, init?: { body?: string }) => {
			const messages = (JSON.parse(init?.body ?? "{}") as { messages: ChatMessage[] }).messages;
			received.push(messages);
			const refused = messages.some((message, index) => message.role === "system" && index > 0);
			const refusal = 'data: {"error":{"message":"System message must be at the beginning.","type":"invalid_request_error","param":null,"code":400}}\n\ndata: [DONE]\n\n';
			return stream(refused ? refusal : `data: ${call}\n\ndata: ${done}\n\ndata: [DONE]\n\n`);
		}) as unknown as typeof fetch;
		const reply = await requestToolCall({ endpoint: "http://stream-refusal.invalid/v1", model: "qwen3.5-9b", fetchImpl, onDelta: () => {} }, CONVERSATION, [tool]);
		expect(reply.toolCalls.map((c) => c.name)).toEqual(["read_file"]);
		expect(received).toHaveLength(2);
	});

	it("a refusal that stays one is the provider's error with its reason, not the model going silent", async () => {
		const fetchImpl = (async () => ({
			ok: true,
			status: 200,
			headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
			body: (async function* () {
				yield new TextEncoder().encode('data: {"error":{"message":"Model is overloaded.","code":503}}\n\ndata: [DONE]\n\n');
			})(),
		})) as unknown as typeof fetch;
		await expect(
			requestToolCall({ endpoint: "http://stream-error.invalid/v1", model: "m", fetchImpl, onDelta: () => {} }, CONVERSATION, [tool]),
		).rejects.toThrow("tool-calling stream error: Model is overloaded.");
	});

	it("a model that really says nothing still sends its frames, and is not retried", async () => {
		const received: ChatMessage[][] = [];
		const fetchImpl = (async (_url: string, init?: { body?: string }) => {
			received.push((JSON.parse(init?.body ?? "{}") as { messages: ChatMessage[] }).messages);
			const role = JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] });
			const stop = JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
			return {
				ok: true,
				status: 200,
				headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
				body: (async function* () {
					yield new TextEncoder().encode(`data: ${role}\n\ndata: ${stop}\n\ndata: [DONE]\n\n`);
				})(),
			};
		}) as unknown as typeof fetch;
		await requestToolCall({ endpoint: "http://really-silent.invalid/v1", model: "m", fetchImpl, onDelta: () => {} }, CONVERSATION, [tool]);
		expect(received).toHaveLength(1);
	});

	it("a provider that takes several system messages receives them untouched", async () => {
		const { fetchImpl, received } = provider(false);
		await requestToolCall({ endpoint: "http://several-system.invalid/v1", model: "command-a", fetchImpl }, CONVERSATION, [tool]);
		expect(received).toHaveLength(1);
		expect(received[0]!.map((message) => message.role)).toEqual(["system", "system", "user", "assistant", "system"]);
	});
});
