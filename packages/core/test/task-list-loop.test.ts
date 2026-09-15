/**
 * E81: the persona writes its own task list inside a real turn, a step is done only when something done
 * backs it, the list comes back after every batch of calls, and the record keeps the one the turn ended with.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compile, DEFAULT_POLICY, PersonaAgent, policyFromPersona, type LoopEvent } from "../src/index.js";
import type { RecordBody } from "../src/record/entry.js";
import { Journal } from "../src/record/journal.js";
import { defaultLoop } from "../src/run/default-provider.js";
import { recordTurns } from "../src/run/recording.js";
import { TurnRunner } from "../src/run/service.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-task-list-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Call = { name: string; args: Record<string, unknown> };
type Sent = Array<{ role: string; content?: unknown }>;

/** A model that makes one scripted call per step, then finishes, and keeps every request it was sent. */
function scripted(calls: readonly Call[]): { fetchImpl: typeof fetch; sent: Sent[] } {
	const sent: Sent[] = [];
	let turn = 0;
	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		sent.push((JSON.parse(init?.body ?? "{}") as { messages?: Sent }).messages ?? []);
		turn += 1;
		const next = calls[turn - 1] ?? { name: "finish", args: { summary: "done" } };
		const call = { id: `c${turn}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } };
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", tool_calls: [call] }, finish_reason: "tool_calls" }] }) };
	}) as unknown as typeof fetch;
	return { fetchImpl, sent };
}

async function turn(calls: readonly Call[]) {
	const model = scripted(calls);
	const permissions = { sandbox: "workspace-write", approval: "never" };
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl: model.fetchImpl },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" },
		capability: compile(policyFromPersona({ permissions }, { personaVersionId: "pv_tasks" })),
	});
	const events: LoopEvent[] = [];
	agent.bus.on((event) => events.push(event));
	const journal = new Journal({});
	await new TurnRunner({ provider: defaultLoop(agent), observer: recordTurns({ journal }) }).run({
		turn: "t1",
		prompt: "make a design and a pitch",
		asker: { kind: "human", id: "david" },
	});
	return { sent: model.sent, events, bodies: journal.all().map((entry) => entry.body) };
}

const isReminder = (message: { role: string; content?: unknown }): boolean =>
	message.role === "system" && String(message.content).includes("Your task list");

describe("the task list inside a turn (E81)", () => {
	const script: Call[] = [
		{ name: "update_tasks", args: { tasks: [{ text: "design", status: "in_progress" }, { text: "pitch", status: "pending" }] } },
		{ name: "write_file", args: { path: "GAME.md", content: "# Frog\n" } },
		// One file written, two steps marked done: only one of them can be backed.
		{ name: "update_tasks", args: { tasks: [{ text: "design", status: "done" }, { text: "pitch", status: "done" }] } },
	];

	it("marks done, and verified, only the step a call backs, and tells the model about the other", async () => {
		const { sent, bodies } = await turn(script);

		const toolReplies = sent[3]!.filter((message) => message.role === "tool").map((message) => String(message.content));
		expect(toolReplies.some((reply) => reply.includes("Marked done with nothing you did backing it: pitch."))).toBe(true);

		const tasks = bodies.find((body): body is Extract<RecordBody, { type: "tasks" }> => body.type === "tasks");
		expect(tasks?.tasks).toEqual([
			{ text: "design", status: "done", verified: true, evidence: ["c2"] },
			{ text: "pitch", status: "done", verified: false },
		]);
	});

	it("puts the list back after every batch of calls, as one message at the end, never two", async () => {
		const { sent } = await turn(script);

		// The request after the file was written: the list is the last thing the model reads.
		const afterWrite = sent[2]!;
		expect(isReminder(afterWrite.at(-1)!)).toBe(true);
		// And every request carries at most one copy.
		for (const request of sent) expect(request.filter(isReminder).length).toBeLessThanOrEqual(1);
	});

	it("shows each revision of the list, and does not count writing it as work that backs a step", async () => {
		const { events, bodies } = await turn([
			{ name: "update_tasks", args: { tasks: [{ text: "pitch", status: "done" }] } },
		]);

		expect(events.filter((event) => event.type === "task-list")).toHaveLength(1);
		const tasks = bodies.find((body): body is Extract<RecordBody, { type: "tasks" }> => body.type === "tasks");
		expect(tasks?.tasks).toEqual([{ text: "pitch", status: "done", verified: false }]);
	});

	it("writes no list to the record when the persona kept none", async () => {
		const { bodies } = await turn([{ name: "write_file", args: { path: "GAME.md", content: "# Frog\n" } }]);

		expect(bodies.some((body) => body.type === "tasks")).toBe(false);
	});
});
