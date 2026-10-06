/**
 * Reading a reply while it is still being written.
 *
 * Before E4, `grep stream` over `tool-calling.ts` returned nothing: a turn blocked
 * until the whole reply landed, so a person watched a spinner for as long as the model
 * took and a screen had nothing to show. Same run, different product.
 *
 * The interesting cases are all about a stream that arrives BADLY, because that is the
 * normal case rather than the exception. A chunk boundary falls in the middle of an
 * event. A tool call's arguments arrive as eleven fragments of a JSON object that is
 * not valid until the last one. An endpoint ignores `stream` entirely and answers with
 * an ordinary body. A frame is malformed. Each of those has a wrong answer that looks
 * like working software: a lost token, a call with truncated arguments, a valid reply
 * read as a protocol error, a turn thrown away over one bad line.
 *
 * The body is a real `ReadableStream` with real chunk boundaries, because chopping the
 * bytes differently is exactly what a network does and what a test with one tidy chunk
 * per event would never see.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY, PersonaAgent, type LoopEvent } from "../src/index.js";
import { requestToolCall, type ToolCallConfig } from "../src/tool-calling.js";

/** A response whose body arrives in exactly these pieces. */
function streaming(chunks: string[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** One SSE event carrying a chat completion chunk. */
const frame = (delta: unknown) =>
	`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

function config(response: Response, onDelta?: (text: string) => void): ToolCallConfig {
	return {
		endpoint: "http://x/v1",
		model: "m",
		fetchImpl: (async () => response) as unknown as typeof fetch,
		...(onDelta ? { onDelta } : {}),
	};
}

describe("text arriving in pieces", () => {
	it("reaches the caller as it arrives, and adds up to the whole reply", async () => {
		// Both halves matter. A caller that only got the total would have nothing to
		// show while the model works, and a caller that only got pieces would have to
		// reassemble a message the loop already needs whole.
		const seen: string[] = [];
		const res = await requestToolCall(
			config(streaming([frame({ content: "Hel" }), frame({ content: "lo" }), "data: [DONE]\n\n"]), (text) =>
				seen.push(text),
			),
			[],
			[],
		);

		expect(seen).toEqual(["Hel", "lo"]);
		expect(res.text).toBe("Hello");
	});

	it("survives a chunk boundary in the middle of an event", async () => {
		// What a network does. An event split across two reads must not be parsed as
		// two events, and the half that arrived first must not be dropped: either
		// mistake loses tokens silently, which is the failure nobody sees.
		const one = frame({ content: "split" });
		const res = await requestToolCall(
			config(streaming([one.slice(0, 20), one.slice(20), "data: [DONE]\n\n"])),
			[],
			[],
		);

		expect(res.text).toBe("split");
	});

	it("reads events separated by CRLF, because some servers send them", async () => {
		const res = await requestToolCall(
			config(streaming([`data: ${JSON.stringify({ choices: [{ delta: { content: "windows" } }] })}\r\n\r\n`])),
			[],
			[],
		);

		expect(res.text).toBe("windows");
	});

	it("skips a frame it cannot parse instead of losing the turn", async () => {
		// One malformed line in the middle of a reply is not a reason to throw away
		// everything that came before it, and a proxy or a keepalive can produce one.
		const res = await requestToolCall(
			config(streaming([frame({ content: "before" }), "data: {not json\n\n", frame({ content: "after" })])),
			[],
			[],
		);

		expect(res.text).toBe("beforeafter");
	});
});

describe("a tool call arriving in pieces", () => {
	it("concatenates its arguments and parses them only at the end", async () => {
		// Half a JSON object is not a smaller JSON object. Parsing each fragment as it
		// lands would fail on every one but the last, and a client that tried would
		// call the tool with empty arguments.
		const res = await requestToolCall(
			config(
				streaming([
					frame({ tool_calls: [{ index: 0, id: "c1", function: { name: "write_file", arguments: '{"pa' } }] }),
					frame({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"' } }] }),
					frame({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }),
					"data: [DONE]\n\n",
				]),
			),
			[],
			[],
		);

		expect(res.toolCalls).toHaveLength(1);
		expect(res.toolCalls[0]).toMatchObject({ id: "c1", name: "write_file", args: { path: "a.txt" } });
	});

	it("keeps two calls apart by their index, and in the order asked for", async () => {
		// The index is how the wire says which call a fragment belongs to. Merging
		// them would produce one call with both sets of arguments concatenated into
		// nonsense, and reordering them would be a different plan than the model made.
		const res = await requestToolCall(
			config(
				streaming([
					frame({ tool_calls: [{ index: 1, id: "second", function: { name: "b", arguments: "{}" } }] }),
					frame({ tool_calls: [{ index: 0, id: "first", function: { name: "a", arguments: "{}" } }] }),
				]),
			),
			[],
			[],
		);

		expect(res.toolCalls.map((call) => call.name)).toEqual(["a", "b"]);
	});
});

describe("what the budget needs from a stream", () => {
	it("keeps the usage the server reports in its final frame", async () => {
		// The loop enforces a token budget. A stream reports usage only when asked, so
		// streaming that lost the numbers would turn a hard stop into a run that never
		// stops, which is the failure mode the budget exists for.
		const res = await requestToolCall(
			config(
				streaming([
					frame({ content: "hi" }),
					`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
					"data: [DONE]\n\n",
				]),
			),
			[],
			[],
		);

		expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
	});

	it("asks for usage whenever it asks for a stream", async () => {
		// The two travel together or the first one costs the second. Checked on the
		// request rather than on the reply, because a server that does not send usage
		// unasked is exactly the case this covers.
		let sent: Record<string, unknown> = {};
		await requestToolCall(
			{
				endpoint: "http://x/v1",
				model: "m",
				onDelta: () => {},
				fetchImpl: (async (_url: string, init: { body: string }) => {
					sent = JSON.parse(init.body);
					return streaming(["data: [DONE]\n\n"]);
				}) as unknown as typeof fetch,
			},
			[],
			[],
		);

		expect(sent.stream).toBe(true);
		expect(sent.stream_options).toEqual({ include_usage: true });
	});

	it("does not ask for a stream when nobody is listening", async () => {
		// A caller with nowhere to put the text should not pay for a stream, and an
		// endpoint that handles `stream` badly should not be exercised for nothing.
		let sent: Record<string, unknown> = {};
		await requestToolCall(
			{
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: (async (_url: string, init: { body: string }) => {
					sent = JSON.parse(init.body);
					return new Response(JSON.stringify({ choices: [{ message: { content: "whole" } }] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}) as unknown as typeof fetch,
			},
			[],
			[],
		);

		expect(sent.stream).toBeUndefined();
	});
});

describe("the loop, which is what makes any of this visible", () => {
	it("emits the text as it arrives, on its own bus", async () => {
		// The control that was missing, and removing the wiring in `agent.ts` left
		// every test above green: they all prove `requestToolCall` can stream, and none
		// of them proved that anything asks it to. Same shape as the mount check in E1,
		// and found the same way, by breaking it.
		const events: LoopEvent[] = [];
		const agent = new PersonaAgent({
			llm: {
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: (async (url: string) => {
					if (String(url).endsWith("/models")) {
						return new Response(JSON.stringify({ data: [] }), {
							status: 200,
							headers: { "content-type": "application/json" },
						});
					}
					return streaming([
						frame({ content: "wor" }),
						frame({ content: "king" }),
						frame({ tool_calls: [{ index: 0, id: "c1", function: { name: "finish", arguments: '{"summary":"done"}' } }] }),
						"data: [DONE]\n\n",
					]);
				}) as unknown as typeof fetch,
			},
			policy: { ...DEFAULT_POLICY, sandbox: "danger-full-access" },
		});
		agent.bus.on((event) => events.push(event));

		await agent.run("say something");

		const deltas = events.filter((event) => event.type === "agent-delta");
		expect(deltas.map((event) => (event as { text: string }).text)).toEqual(["wor", "king"]);
	});
});

describe("an endpoint that ignores the request to stream", () => {
	it("is read as an ordinary reply rather than as a protocol error", async () => {
		// Local runtimes and proxies do this. The decision comes from the RESPONSE, not
		// from what was asked for: a client that insisted on parsing events would read
		// a perfectly good answer as a failure.
		const res = await requestToolCall(
			config(
				new Response(JSON.stringify({ choices: [{ message: { content: "whole answer" } }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				() => {
					throw new Error("nothing should have streamed");
				},
			),
			[],
			[],
		);

		expect(res.text).toBe("whole answer");
	});
});
