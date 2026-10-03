/**
 * E165 and E166: two replies that look like answers and are not.
 *
 * Read raw on 2026-10-03 with Nemotron 3.5 Lightning on NVIDIA's API: when the model does not close its reasoning, the
 * API returns the same text in `content` and in `reasoning_content`, and the persona delivered its reasoning as the
 * reply; and a text reply that ran out of room (`finish: length`, 16,381 characters of a repeated fragment) closed the
 * turn answered. These run the loop with a scripted model.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compile, DEFAULT_POLICY, PersonaAgent, policyFromPersona } from "../src/index.js";
import { requestToolCall } from "../src/tool-calling.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-not-an-answer-"));
	writeFileSync(join(dir, "notes.md"), "# Notes\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Step = { content?: string; reasoning?: string; finish?: string };
type Sent = Array<{ role: string; content?: unknown }>;

function scripted(steps: readonly Step[]): { fetchImpl: typeof fetch; sent: Sent[] } {
	const sent: Sent[] = [];
	let turn = 0;
	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		sent.push((JSON.parse(init?.body ?? "{}") as { messages?: Sent }).messages ?? []);
		const step = steps[turn] ?? { content: "done" };
		turn += 1;
		const message = { content: step.content ?? "", ...(step.reasoning ? { reasoning_content: step.reasoning } : {}) };
		return { ok: true, status: 200, json: async () => ({ choices: [{ message, finish_reason: step.finish ?? "stop" }] }) };
	}) as unknown as typeof fetch;
	return { fetchImpl, sent };
}

async function run(steps: readonly Step[]) {
	const model = scripted(steps);
	const permissions = { sandbox: "workspace-write", approval: "never" };
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl: model.fetchImpl },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" },
		capability: compile(policyFromPersona({ permissions }, { personaVersionId: "pv_not_an_answer" })),
	});
	const result = await agent.run("can you check the status of flight UA 512?");
	return { result, sent: model.sent };
}

const THINKING = "Here's a thinking process:\n1. Analyze User Input: the user wants a flight status, which is not my role.";
const ANSWER = "Flight status is outside what I do: I design games. Your airline's app has it.";

describe("a reply whose text is its own reasoning (E166)", () => {
	it("is not the answer: the model is told once that only its reasoning came back, and its next reply is the answer", async () => {
		const { result, sent } = await run([{ content: THINKING, reasoning: THINKING }, { content: ANSWER }]);

		expect(result.finished).toBe(true);
		expect(result.summary).toBe(ANSWER);
		const note = sent[1]!.find((message) => message.role === "system" && /only your reasoning came back/i.test(String(message.content)));
		expect(note).toBeDefined();
		// The reasoning never enters the conversation as something the persona said.
		expect(sent[1]!.some((message) => message.role === "assistant" && String(message.content).includes("thinking process"))).toBe(false);
	});

	it("an answer that only shares part of its reasoning still stands", async () => {
		const { result, sent } = await run([{ content: ANSWER, reasoning: `The user asks about flights. ${ANSWER}` }]);

		expect(result.summary).toBe(ANSWER);
		expect(sent).toHaveLength(1);
	});

	it("the client reads the echo from a streamed reply too", async () => {
		const sse = (frames: object[]): string => `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
		const fetchImpl = (async () =>
			new Response(
				sse([
					{ choices: [{ delta: { role: "assistant", reasoning_content: "Here's a thinking ", content: "Here's a thinking " } }] },
					{ choices: [{ delta: { reasoning_content: "process:", content: "process:" } }] },
					{ choices: [{ delta: {}, finish_reason: "length" }] },
				]),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			)) as unknown as typeof fetch;

		const reply = await requestToolCall({ endpoint: "http://x/v1", model: "m", fetchImpl, onDelta: () => {} }, [{ role: "user", content: "hi" }], []);

		expect(reply).toMatchObject({ text: "", toolCalls: [], finish: "length", reasoned: true });
	});
});

describe("a text reply cut at the length limit (E165)", () => {
	it("is not the answer: the model is told once, the cut text stays out of the conversation, and its next reply is the answer", async () => {
		const cut = `The${"ells".repeat(200)}`;
		const { result, sent } = await run([{ content: cut, finish: "length" }, { content: ANSWER }]);

		expect(result.finished).toBe(true);
		expect(result.summary).toBe(ANSWER);
		const note = sent[1]!.find((message) => message.role === "system" && /cut at the length limit/i.test(String(message.content)));
		expect(note).toBeDefined();
		expect(sent[1]!.some((message) => message.role === "assistant" && String(message.content).includes("ellsells"))).toBe(false);
	});

	it("a second cut in a row goes through as it is, rather than looping", async () => {
		const { result, sent } = await run([
			{ content: "A long answer that", finish: "length" },
			{ content: "A shorter answer that still", finish: "length" },
		]);

		expect(sent).toHaveLength(2);
		expect(result.summary).toBe("A shorter answer that still");
	});

	it("a reply that ended on its own is untouched", async () => {
		const { result, sent } = await run([{ content: ANSWER, finish: "stop" }]);

		expect(result.summary).toBe(ANSWER);
		expect(sent).toHaveLength(1);
	});
});
