/**
 * E94: a reply with no text and no action is not an answer.
 *
 * Measured on 2026-09-15 against `command-a-plus-05-2026`: after reading its reference and loading two
 * skills, the model ended its turn with `finish_reason: stop`, its reasoning, and no text, and the loop
 * closed the turn as answered, with nothing for the person. These run the loop with a scripted model.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compile, DEFAULT_POLICY, PersonaAgent, policyFromPersona } from "../src/index.js";
import { productOf } from "../src/run/default-provider.js";
import { requestToolCall } from "../src/tool-calling.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-empty-reply-"));
	writeFileSync(join(dir, "notes.md"), "# Notes\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Step = { content?: string; reasoning?: string; call?: { name: string; args: Record<string, unknown> } };
type Sent = Array<{ role: string; content?: unknown; tool_calls?: unknown }>;

/** A model that answers each request with the next scripted step, and keeps what it was sent. */
function scripted(steps: readonly Step[]): { fetchImpl: typeof fetch; sent: Sent[] } {
	const sent: Sent[] = [];
	let turn = 0;
	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		sent.push((JSON.parse(init?.body ?? "{}") as { messages?: Sent }).messages ?? []);
		const step = steps[turn] ?? { content: "done" };
		turn += 1;
		const message = {
			content: step.content ?? "",
			...(step.reasoning ? { reasoning_content: step.reasoning } : {}),
			...(step.call
				? { tool_calls: [{ id: `c${turn}`, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args) } }] }
				: {}),
		};
		return { ok: true, status: 200, json: async () => ({ choices: [{ message, finish_reason: step.call ? "tool_calls" : "stop" }] }) };
	}) as unknown as typeof fetch;
	return { fetchImpl, sent };
}

async function run(steps: readonly Step[]) {
	const model = scripted(steps);
	const permissions = { sandbox: "workspace-write", approval: "never" };
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl: model.fetchImpl },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" },
		capability: compile(policyFromPersona({ permissions }, { personaVersionId: "pv_empty" })),
	});
	const result = await agent.run("which sources is your advice based on?");
	return { result, sent: model.sent };
}

describe("an empty reply (E94)", () => {
	it("is not taken as the answer: the model is told once, and its next reply is the answer", async () => {
		const { result, sent } = await run([
			{ content: "", reasoning: "The sources are in my reference." },
			{ content: "Steve Swink's Game Feel and Jan Willem Nijman's talk on juice." },
		]);

		expect(result.finished).toBe(true);
		expect(result.summary).toBe("Steve Swink's Game Feel and Jan Willem Nijman's talk on juice.");
		const second = sent[1]!;
		const note = second.find((message) => message.role === "system" && /no text/i.test(String(message.content)));
		expect(note).toBeDefined();
		// Its reasoning is named: a model that thought its answer through believes it gave one.
		expect(String(note!.content)).toMatch(/reasoning/i);
		// Nothing empty goes into the conversation. Some providers refuse an empty message outright.
		expect(second.filter((message) => message.role === "assistant" && !message.content && message.tool_calls === undefined)).toEqual([]);
	});

	it("closes the turn empty when it comes back empty again and nothing was done", async () => {
		const { result } = await run([{ content: "" }, { content: "   " }]);

		expect(result.finished).toBe(false);
		expect(result.budget.stoppedBy).toBe("empty");
		const product = productOf(result);
		expect(product.stopReason).toBe("empty");
		expect(product.answer).toBe("");
		expect(product.failure?.code).toBe("empty");
	});

	it("ends the turn, without words, when the work was done before the silence", async () => {
		const { result } = await run([{ call: { name: "read_file", args: { path: "notes.md" } } }, { content: "" }, { content: "" }]);

		expect(result.finished).toBe(true);
		expect(result.summary).toBe("");
		expect(productOf(result).stopReason).toBe("answered");
	});
});

describe("what the client keeps about how a reply ended (E94)", () => {
	const sse = (frames: object[]): string => `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;

	it("keeps the finish reason, and that reasoning came, from a streamed reply", async () => {
		const fetchImpl = (async () =>
			new Response(
				sse([
					{ choices: [{ delta: { role: "assistant", reasoning_content: "thinking about the sources" } }] },
					{ choices: [{ delta: {}, finish_reason: "stop" }] },
				]),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			)) as unknown as typeof fetch;

		const reply = await requestToolCall({ endpoint: "http://x/v1", model: "m", fetchImpl, onDelta: () => {} }, [{ role: "user", content: "hi" }], []);

		expect(reply).toMatchObject({ text: "", toolCalls: [], finish: "stop", reasoned: true });
	});

	it("keeps them from a whole reply too", async () => {
		const fetchImpl = (async () => ({
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: "", reasoning_content: "thinking" }, finish_reason: "length" }] }),
		})) as unknown as typeof fetch;

		const reply = await requestToolCall({ endpoint: "http://x/v1", model: "m", fetchImpl }, [{ role: "user", content: "hi" }], []);

		expect(reply).toMatchObject({ finish: "length", reasoned: true });
	});
});
