/**
 * Conformance: one real sample per model family.
 *
 * The failure this exists for is silent, which is why it needs samples rather than a
 * description. An open model trained to write `<tool_call>{...}</tool_call>` writes
 * exactly that, as content, whenever the server in front of it lacks the matching
 * parser. `tool_calls` comes back empty, the text IS a call, and the loop concludes
 * the model chose to talk. No tool runs, no gate fires, nothing errors, and the run
 * wanders until the step budget stops it.
 *
 * Every sample here is the shape the family actually emits, not a tidied version of
 * it. That distinction has teeth in at least one case: DeepSeek's separators are
 * full-width characters, U+FF5C and U+2581, which look like the ASCII pipe and
 * underscore and are not. A parser written from a description of that format compiles,
 * passes a hand-written test, and matches nothing in production.
 */

import { describe, expect, it } from "vitest";

import { requestToolCall } from "../src/tool-calling.js";
import { DIALECTS, readDialect } from "../src/tools/dialects.js";

const OFFERED = ["read_file", "write_file", "get_weather", "run_command"];

describe("the families, one sample each", () => {
	it("reads Hermes and Qwen", () => {
		const reading = readDialect(
			'I will look at that file.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n</tool_call>',
			OFFERED,
		);

		expect(reading?.dialect).toBe("hermes");
		expect(reading?.calls).toEqual([{ id: "dialect_0", name: "read_file", args: { path: "a.txt" } }]);
	});

	it("reads Mistral, whose calls arrive as a list", () => {
		const reading = readDialect(
			'[TOOL_CALLS] [{"name": "get_weather", "arguments": {"city": "Paris"}}]',
			OFFERED,
		);

		expect(reading?.dialect).toBe("mistral");
		expect(reading?.calls[0]).toMatchObject({ name: "get_weather", args: { city: "Paris" } });
	});

	it("reads two calls out of one Mistral list", () => {
		// A list is a list. Reading only its first element would drop half the plan
		// silently, which is the same class of failure one level down.
		const reading = readDialect(
			'[TOOL_CALLS] [{"name": "read_file", "arguments": {"path": "a"}}, {"name": "read_file", "arguments": {"path": "b"}}]',
			OFFERED,
		);

		expect(reading?.calls).toHaveLength(2);
		expect(reading?.calls.map((call) => call.args.path)).toEqual(["a", "b"]);
	});

	it("reads Llama, which spells the field `parameters`", () => {
		// `arguments` and `parameters` both appear in the wild. A reader that knew one
		// would produce a call with NO arguments: the tool runs, with defaults, on a
		// request that asked for something specific.
		const reading = readDialect(
			'<|python_tag|>{"name": "get_weather", "parameters": {"city": "Lima"}}<|eom_id|>',
			OFFERED,
		);

		expect(reading?.dialect).toBe("llama");
		expect(reading?.calls[0]).toMatchObject({ name: "get_weather", args: { city: "Lima" } });
	});

	it("reads DeepSeek, full-width separators and all", () => {
		const reading = readDialect(
			"<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file\n```json\n{\"path\": \"deep.txt\"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>",
			OFFERED,
		);

		expect(reading?.dialect).toBe("deepseek");
		expect(reading?.calls[0]).toMatchObject({ name: "read_file", args: { path: "deep.txt" } });
	});

	it("reads the XML shape, whose parameters are separate elements", () => {
		const reading = readDialect(
			'<function_calls><invoke name="write_file"><parameter name="path">out.txt</parameter><parameter name="content">hello</parameter></invoke></function_calls>',
			OFFERED,
		);

		expect(reading?.dialect).toBe("xml");
		expect(reading?.calls[0]).toMatchObject({
			name: "write_file",
			args: { path: "out.txt", content: "hello" },
		});
	});

	it("improvised: what a model writes when nothing applied its chat template", () => {
		// Verbatim from Llama-3.1-8B on 2026-09-10, one tool described in prose and no
		// `tools` field. Its own `<|python_tag|>` dialect does not match this, because
		// nothing inserted the tag. Recorded fully in `dialects-improvised.test.ts`.
		const reading = readDialect('get_charge({"id": "ch_42"})', ["get_charge"]);
		expect(reading?.dialect).toBe("improvised");
		expect(reading?.calls[0]).toMatchObject({ name: "get_charge", args: { id: "ch_42" } });
	});

	it("reads Qwen 3.5, whose call is one element per argument and not JSON (E144)", () => {
		// The shape read raw on 2026-09-28 from Qwen/Qwen3.5-9B through together, where it arrived inside the reasoning.
		const reading = readDialect(
			"<tool_call>\n<function=read_file>\n<parameter=path>\ngame.html\n</parameter>\n</function>\n</tool_call>",
			OFFERED,
		);

		expect(reading?.dialect).toBe("qwen-xml");
		expect(reading?.calls).toEqual([{ id: "dialect_0", name: "read_file", args: { path: "game.html" } }]);
	});

	it("keeps a value's own whitespace, taking off only the template's newline on each side", () => {
		const reading = readDialect(
			"<tool_call>\n<function=write_file>\n<parameter=path>\na.txt\n</parameter>\n<parameter=content>\n  two spaces\nand a line\n\n</parameter>\n</function>\n</tool_call>",
			OFFERED,
		);

		expect(reading?.calls[0]?.args).toEqual({ path: "a.txt", content: "  two spaces\nand a line\n" });
	});

	it("has a sample for every dialect it ships, so none goes untested", () => {
		// The gate on this file. A dialect added without a sample is a parser nobody
		// has run against real output, which is the thing this test exists to prevent.
		const tested = new Set(["qwen-xml", "hermes", "mistral", "llama", "deepseek", "xml", "improvised"]);
		expect(DIALECTS.map((dialect) => dialect.name).filter((name) => !tested.has(name))).toEqual([]);
	});
});

describe("what it refuses to do", () => {
	it("drops a name that was not offered this turn, and reports it", () => {
		// The model cannot have been asked for it, so reading it out of prose means a
		// hallucination or something that arrived in the context from outside. Neither
		// is a call worth making, and both are worth knowing about.
		const reading = readDialect('<tool_call>{"name": "exfiltrate", "arguments": {}}</tool_call>', OFFERED);

		expect(reading?.calls).toEqual([]);
		expect(reading?.unknown).toEqual(["exfiltrate"]);
	});

	it("does not guess at the nearest tool name", () => {
		// `read_fil` is one character from a real tool. Repairing it would run something
		// the model did not name, and the repair layer's job is arguments, not identity.
		const reading = readDialect('<tool_call>{"name": "read_fil", "arguments": {}}</tool_call>', OFFERED);

		expect(reading?.calls).toEqual([]);
	});

	it("says nothing about ordinary prose", () => {
		// The control that keeps this from being a parser that fires on everything. A
		// reply mentioning a tool by name is a reply, not a call.
		expect(readDialect("I could read_file for you, but I would rather ask first.", OFFERED)).toBeUndefined();
		expect(readDialect("", OFFERED)).toBeUndefined();
	});

	it("does not read a call out of a code fence a person asked about", () => {
		// A model explaining the syntax is not a model using it. This one is honest
		// about its limit: the marker IS present, so the reading happens and the name is
		// checked, and what saves it is that documentation examples name tools that do
		// not exist. A sample naming a real tool would be read as a call, and the gate
		// is what stands behind that, which is why the gate is not optional.
		const reading = readDialect(
			'Here is how the format looks:\n```\n<tool_call>{"name": "some_tool", "arguments": {}}</tool_call>\n```',
			OFFERED,
		);

		expect(reading?.calls).toEqual([]);
	});
});

describe("what a person is left reading", () => {
	it("takes the call syntax out of the visible text", () => {
		// Leaving it in shows somebody the raw markup of a call that is about to run,
		// which reads as the persona losing its footing rather than as the runtime
		// doing its job.
		const reading = readDialect(
			'Let me check that.\n<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>',
			OFFERED,
		);

		expect(reading?.text).toBe("Let me check that.");
	});

	it("keeps prose that came after the call as well", () => {
		const reading = readDialect(
			'<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>\nThen I will summarise it.',
			OFFERED,
		);

		expect(reading?.text).toBe("Then I will summarise it.");
	});
});

describe("the silent failure this exists to end", () => {
	/** An endpoint that answers with a call written as prose, which is the whole case. */
	function endpointSaying(content: string): typeof fetch {
		return (async () => ({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => ({ choices: [{ message: { content } }] }),
		})) as unknown as typeof fetch;
	}

	const tools = [
		{
			name: "read_file",
			description: "reads a file",
			// "fs", not "file": there is no "file" category, and this said so for as long as
			// nothing type-checked the tests. Category is what tool subsetting reads, so a
			// stub in a category the product does not have was exercising a branch nobody
			// can reach in production.
			category: "fs" as const,
			parameters: { type: "object" as const, properties: {} },
			// Declared rather than defaulted: these two decide whether the loop may run
			// this tool alongside another, and a stub that omits them is a stub that does
			// not resemble the thing it stands for.
			isReadOnly: true,
			isConcurrencySafe: true,
			gate: () => ({ decision: "allow" as const, reason: "", class: { writesFiles: false, network: false, destructive: false, escapesWorkspace: false } }),
			execute: async () => "",
		},
	];

	it("turns a reply that WAS a call into a call", async () => {
		// Before E7 this returned zero tool calls and a string of markup, and the loop
		// read it as the model choosing to talk. Nothing failed. Nothing ran either.
		const res = await requestToolCall(
			{
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: endpointSaying('<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>'),
			},
			[],
			tools,
		);

		expect(res.toolCalls).toHaveLength(1);
		expect(res.toolCalls[0]).toMatchObject({ name: "read_file", args: { path: "a.txt" } });
		expect(res.dialect).toBe("hermes");
	});

	it("leaves a well-formed reply completely alone", async () => {
		// Only runs when the native path found nothing, so a proper reply can never be
		// re-read into something else.
		const res = await requestToolCall(
			{
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: (async () => ({
					ok: true,
					status: 200,
					headers: new Headers({ "content-type": "application/json" }),
					json: async () => ({
						choices: [
							{
								message: {
									content: '<tool_call>{"name": "read_file", "arguments": {"path": "decoy"}}</tool_call>',
									tool_calls: [
										{ id: "native", type: "function", function: { name: "read_file", arguments: '{"path":"real"}' } },
									],
								},
							},
						],
					}),
				})) as unknown as typeof fetch,
			},
			[],
			tools,
		);

		expect(res.toolCalls).toHaveLength(1);
		expect(res.toolCalls[0]?.args).toEqual({ path: "real" });
		expect(res.dialect).toBeUndefined();
	});

	it("reports the family even when it could not use any of the names", async () => {
		// A deployment missing its parser is worth surfacing on its own. Without this
		// the only symptom is a persona that talks about acting and never acts.
		const res = await requestToolCall(
			{
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: endpointSaying('<tool_call>{"name": "not_offered", "arguments": {}}</tool_call>'),
			},
			[],
			tools,
		);

		expect(res.toolCalls).toEqual([]);
		expect(res.dialect).toBe("hermes");
		expect(res.unknownTools).toEqual(["not_offered"]);
	});

	it("leaves ordinary prose as ordinary prose", async () => {
		const res = await requestToolCall(
			{ endpoint: "http://x/v1", model: "m", fetchImpl: endpointSaying("Here is the answer.") },
			[],
			tools,
		);

		expect(res.text).toBe("Here is the answer.");
		expect(res.dialect).toBeUndefined();
	});
});

describe("a call the provider left inside the reasoning (E144)", () => {
	/** A streamed reply as `together` sent it: reasoning frames, no content, `finish: stop`. */
	function streamed(reasoning: string, content = ""): typeof fetch {
		const frames = [
			...reasoning.match(/[\s\S]{1,40}/g)!.map((piece) => ({ choices: [{ delta: { reasoning_content: piece } }] })),
			...(content ? [{ choices: [{ delta: { content } }] }] : []),
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
		];
		const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
		return (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
	}
	const tools = [
		{
			name: "read_file",
			description: "reads a file",
			category: "fs" as const,
			parameters: { type: "object" as const, properties: {} },
			isReadOnly: true,
			isConcurrencySafe: true,
			gate: () => ({ decision: "allow" as const, reason: "", class: { writesFiles: false, network: false, destructive: false, escapesWorkspace: false } }),
			execute: async () => "",
		},
	];
	const ask = (fetchImpl: typeof fetch) =>
		requestToolCall({ endpoint: "http://x/v1", model: "m", fetchImpl, onDelta: () => {} }, [], tools);
	const CALL = "<tool_call>\n<function=read_file>\n<parameter=path>\ngame.html\n</parameter>\n</function>\n</tool_call>";

	it("the together reply: reasoning that ends in the call becomes the call", async () => {
		const res = await ask(streamed(`I need to read the game file first to see why it stops.\n${CALL}\n`));
		expect(res.toolCalls).toHaveLength(1);
		expect(res.toolCalls[0]).toMatchObject({ name: "read_file", args: { path: "game.html" } });
		expect(res.dialect).toBe("qwen-xml (in reasoning)");
		expect(res.text).toBe("");
	});

	it("a call considered midway and then moved past is not read", async () => {
		const res = await ask(streamed(`Maybe ${CALL} but no, I should answer directly instead.`));
		expect(res.toolCalls).toEqual([]);
		expect(res.dialect).toBeUndefined();
	});

	it("a reply that said something is never re-read from its reasoning", async () => {
		const res = await ask(streamed(`Thinking. ${CALL}`, "Here is my answer."));
		expect(res.toolCalls).toEqual([]);
		expect(res.text).toBe("Here is my answer.");
	});

	it("a tool that was not offered is not run, and is reported", async () => {
		const res = await ask(streamed(`<tool_call>\n<function=run_command>\n<parameter=cmd>\nrm -rf .\n</parameter>\n</function>\n</tool_call>`));
		expect(res.toolCalls).toEqual([]);
	});

	it("reasoning with no call stays an empty reply, for E94 to handle as before", async () => {
		const res = await ask(streamed("I am not sure what to do next."));
		expect(res.toolCalls).toEqual([]);
		expect(res.reasoned).toBe(true);
	});
});

describe("arguments that arrived badly", () => {
	it("repairs almost-JSON rather than dropping the call", () => {
		// The repair layer already exists for exactly this and is reused rather than
		// reimplemented. A trailing comma is not a reason to lose a turn.
		const reading = readDialect(
			'<tool_call>{"name": "read_file", "arguments": {"path": "a.txt",}}</tool_call>',
			OFFERED,
		);

		expect(reading?.calls[0]).toMatchObject({ name: "read_file", args: { path: "a.txt" } });
	});

	it("takes arguments that are a JSON string rather than an object", () => {
		// Both shapes are emitted, and the string form is what the native path already
		// receives, so a reader that only handled objects would be stricter than the
		// endpoint it is standing in for.
		const reading = readDialect(
			'<tool_call>{"name": "read_file", "arguments": "{\\"path\\": \\"a.txt\\"}"}</tool_call>',
			OFFERED,
		);

		expect(reading?.calls[0]?.args).toEqual({ path: "a.txt" });
	});

	it("keeps a call whose arguments are unreadable, with none", () => {
		// The name is the part that matters for the gate. A call with no arguments is
		// refused or fails a schema check downstream, which is a visible outcome; a
		// dropped call is a turn that did nothing and said nothing.
		const reading = readDialect('<tool_call>{"name": "read_file", "arguments": "!!!"}</tool_call>', OFFERED);

		expect(reading?.calls[0]).toMatchObject({ name: "read_file", args: {} });
	});
});
