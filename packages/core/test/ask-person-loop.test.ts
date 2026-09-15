/**
 * E84: a question inside a real turn. With a person in front of it the answer comes back to the persona; with
 * nobody the turn stops at the question, written down, and nothing is guessed; a delegated sub-task never
 * reaches the person; and a service step that stops at a question leaves its run waiting.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compile, DEFAULT_POLICY, PersonaAgent, policyFromPersona } from "../src/index.js";
import { Journal } from "../src/record/journal.js";
import { defaultLoop } from "../src/run/default-provider.js";
import { delegate } from "../src/run/delegation.js";
import { recordTurns } from "../src/run/recording.js";
import { subTaskSession } from "../src/run/runner-for.js";
import { TurnRunner } from "../src/run/service.js";
import { runService, type ServiceDef, type ServicePorts } from "../src/service/compose.js";
import type { PersonQuestion } from "../src/tools/ask-person.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-ask-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Call = { name: string; args: Record<string, unknown> };

const QUESTION: PersonQuestion = {
	question: "Which engine should the prototype use?",
	options: [
		{ label: "Plain canvas", detail: "one file, no dependencies" },
		{ label: "Phaser", detail: "a library to load" },
	],
	recommended: "Plain canvas",
};
const ASK: Call = { name: "ask_person", args: { ...QUESTION } };

/** A model that answers each request with its next batch of calls, then finishes, and counts the requests. */
function scripted(batches: readonly (readonly Call[])[]) {
	const state = { requests: 0, offered: [] as string[] };
	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		state.requests += 1;
		if (state.requests === 1) {
			const body = JSON.parse(init?.body ?? "{}") as { tools?: { function: { name: string } }[] };
			state.offered = (body.tools ?? []).map((tool) => tool.function.name);
		}
		const batch = batches[state.requests - 1] ?? [{ name: "finish", args: { summary: "done" } }];
		const tool_calls = batch.map((call, index) => ({
			id: `c${state.requests}-${index}`,
			type: "function",
			function: { name: call.name, arguments: JSON.stringify(call.args) },
		}));
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", tool_calls }, finish_reason: "tool_calls" }] }) };
	}) as unknown as typeof fetch;
	return { fetchImpl, state };
}

async function turn(batches: readonly (readonly Call[])[], onQuestion?: (question: PersonQuestion) => Promise<string>) {
	const model = scripted(batches);
	const permissions = { sandbox: "workspace-write", approval: "never" };
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl: model.fetchImpl },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" },
		capability: compile(policyFromPersona({ permissions }, { personaVersionId: "pv_ask" })),
		...(onQuestion === undefined ? {} : { onQuestion }),
	});
	const journal = new Journal({});
	const outcome = await new TurnRunner({ provider: defaultLoop(agent), observer: recordTurns({ journal }) }).run({
		turn: "t1",
		prompt: "Make me a prototype of the frog game.",
		asker: { kind: "human", id: "david" },
	});
	return { outcome, entries: journal.all(), messages: agent.lastMessages ?? [], requests: model.state.requests, offered: model.state.offered };
}

describe("asking a person inside a turn (E84)", () => {
	it("with a person in front of it, brings the answer back and writes both, each in its author's name", async () => {
		const seen: PersonQuestion[] = [];
		const { outcome, entries, messages } = await turn([[ASK]], async (question) => {
			seen.push(question);
			return "Plain canvas";
		});

		expect(seen).toEqual([QUESTION]);
		expect(messages.some((message) => message.role === "tool" && message.content === "The person answered: Plain canvas")).toBe(true);
		expect(outcome.stopReason).toBe("answered");
		expect(outcome.questions).toEqual([{ ...QUESTION, answer: "Plain canvas" }]);

		const question = entries.find((entry) => entry.body.type === "question");
		const answer = entries.find((entry) => entry.body.type === "answer");
		expect(question?.author.kind).toBe("persona");
		expect(question?.body).toMatchObject({ question: QUESTION.question, recommended: "Plain canvas" });
		expect(answer?.author).toEqual({ kind: "human", id: "david" });
		expect(answer?.body).toMatchObject({ question: QUESTION.question, answer: "Plain canvas" });
	});

	it("with nobody to answer, stops at the question, written down, and guesses nothing", async () => {
		const { outcome, entries, requests, offered } = await turn([[ASK]]);

		// Offered to the model, not only handled when called: the loop reads the name before the catalogue.
		expect(offered).toContain("ask_person");
		expect(outcome.stopReason).toBe("stopped");
		expect(outcome.answer).toContain("Waiting for an answer before going on");
		expect(outcome.answer).toContain("1. Plain canvas (recommended): one file, no dependencies");
		expect(outcome.questions).toEqual([QUESTION]);
		// No second request: the model is not asked to carry on past a question nobody answered.
		expect(requests).toBe(1);
		expect(entries.some((entry) => entry.body.type === "question")).toBe(true);
		expect(entries.some((entry) => entry.body.type === "answer")).toBe(false);
	});

	it("gives every call of the batch it stopped in a result, so the transcript can be sent again", async () => {
		const { messages } = await turn([[ASK, { name: "write_file", args: { path: "GAME.md", content: "# Frog" } }]]);

		const asked = messages.find((message) => message.role === "assistant" && (message.tool_calls ?? []).length === 2);
		expect(asked).toBeDefined();
		for (const call of asked!.tool_calls!) {
			expect(messages.some((message) => message.role === "tool" && message.tool_call_id === call.id)).toBe(true);
		}
	});

	it("sends a question it cannot ask as written back as an error, and the turn goes on", async () => {
		const { outcome, messages } = await turn([[{ name: "ask_person", args: { question: "Go on?", options: [{ label: "Yes" }] } }]]);

		expect(messages.some((message) => message.role === "tool" && String(message.content).includes("at least two options"))).toBe(true);
		expect(outcome.stopReason).toBe("answered");
		expect(outcome.questions).toBeUndefined();
	});
});

describe("where nobody can answer (E84, P10 of E77)", () => {
	it("never hands a delegated sub-task its parent's way to reach a person", () => {
		const photograph = delegate({ parentDepth: 0, parentScope: {}, maxDepth: 2 });
		if (!photograph.ok) throw new Error(photograph.reason);

		const child = subTaskSession({ onQuestion: async () => "yes" }, photograph.scope, "a sub-task");

		expect(child.onQuestion).toBeUndefined();
	});

	it("leaves a service run waiting when a step stops at a question, and starts nothing after it", async () => {
		const def: ServiceDef = {
			address: "local/games",
			name: "games",
			steps: [
				{ position: 1, personaRef: "gamewright", instruction: "Design the game." },
				{ position: 2, personaRef: "gamewright", instruction: "Build the prototype." },
			],
		};
		const started: number[] = [];
		const ports: ServicePorts = {
			resolveService: () => undefined,
			runPersonaStep: async ({ position }) => {
				started.push(position);
				return { outcome: "failed", summary: null, reason: "waiting for an answer: Which engine should the prototype use?", waitingOnPerson: true };
			},
			approve: async () => "unavailable",
		};

		const result = await runService(def, ports);

		expect(result.status).toBe("waiting");
		expect(result.reason).toContain("Which engine should the prototype use?");
		expect(started).toEqual([1]);
	});
});
