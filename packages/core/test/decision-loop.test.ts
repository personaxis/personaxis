/**
 * E83: the decision step inside a real turn. A model on a `small` scaffold decides first, with no tools; the
 * route comes back as a note and every tool stays offered; `work` goes through the planning gate; the record
 * keeps the decision in the persona's name; and a model on `standard` never makes the call.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compile, DEFAULT_POLICY, PersonaAgent, policyFromPersona, type LoopEvent } from "../src/index.js";
import { PLAN_INSTRUCTION } from "../src/plan-run.js";
import { DECIDE_INSTRUCTION } from "../src/run/decide.js";
import type { Scaffold } from "../src/run/model-seam.js";
import type { RecordBody } from "../src/record/entry.js";
import { Journal } from "../src/record/journal.js";
import { defaultLoop } from "../src/run/default-provider.js";
import { recordTurns } from "../src/run/recording.js";
import { TurnRunner } from "../src/run/service.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-decide-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Request = { messages: Array<{ role: string; content?: unknown }>; tools: unknown[]; toolsField: boolean };

/**
 * A model that answers requests without tools from `texts`, in order, and requests with tools by finishing.
 * Keeps every request it was sent.
 */
function scripted(texts: readonly string[]): { fetchImpl: typeof fetch; sent: Request[] } {
	const sent: Request[] = [];
	let written = 0;
	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		const body = JSON.parse(init?.body ?? "{}") as { messages?: Request["messages"]; tools?: unknown[] };
		const request = { messages: body.messages ?? [], tools: body.tools ?? [], toolsField: "tools" in body };
		sent.push(request);
		if (request.tools.length === 0) {
			const content = texts[written] ?? "";
			written += 1;
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }) };
		}
		const call = { id: `c${sent.length}`, type: "function", function: { name: "finish", arguments: JSON.stringify({ summary: "done" }) } };
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", tool_calls: [call] }, finish_reason: "tool_calls" }] }) };
	}) as unknown as typeof fetch;
	return { fetchImpl, sent };
}

async function turn(texts: readonly string[], scaffold?: Scaffold) {
	const model = scripted(texts);
	const permissions = { sandbox: "workspace-write", approval: "never" };
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl: model.fetchImpl, ...(scaffold === undefined ? {} : { scaffold }) },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" },
		capability: compile(policyFromPersona({ permissions }, { personaVersionId: "pv_decide" })),
	});
	const events: LoopEvent[] = [];
	agent.bus.on((event) => events.push(event));
	const journal = new Journal({});
	await new TurnRunner({ provider: defaultLoop(agent), observer: recordTurns({ journal }) }).run({
		turn: "t1",
		prompt: "Which sources is your advice based on?",
		asker: { kind: "human", id: "david" },
	});
	return { sent: model.sent, events, entries: journal.all() };
}

const says = (request: Request, text: string): boolean => request.messages.some((message) => String(message.content).includes(text));
const decisionOf = (entries: ReturnType<Journal["all"]>) => entries.find((entry) => entry.body.type === "decision");

describe("deciding before acting (E83)", () => {
	it("on a small scaffold, decides first with no tools, then acts with the route as a note and every tool", async () => {
		const { sent, entries } = await turn(['{"route": "consult", "why": "the sources are in my reference"}'], "small");

		expect(sent[0]!.tools).toEqual([]);
		// No field at all, not an empty list: HuggingFace's router answers 400 to an empty list with a choice.
		expect(sent[0]!.toolsField).toBe(false);
		expect(String(sent[0]!.messages.at(-1)!.content)).toBe(DECIDE_INSTRUCTION);

		const acting = sent[1]!;
		expect(acting.tools.length).toBeGreaterThan(0);
		expect(says(acting, "You decided this request needs: consult (the sources are in my reference)")).toBe(true);
		// The instruction was for the step, and the conversation does not keep it.
		expect(says(acting, DECIDE_INSTRUCTION)).toBe(false);

		const decision = decisionOf(entries);
		expect(decision?.body).toEqual({ type: "decision", turn: "t1", route: "consult", why: "the sources are in my reference" } satisfies RecordBody);
		// The persona's words, so the persona is the author, and it comes before anything else the turn did.
		expect(decision?.author.kind).toBe("persona");
		const kinds = entries.map((entry) => entry.body.type);
		expect(kinds.indexOf("decision")).toBeLessThan(kinds.indexOf("turn-close"));
		expect(kinds.indexOf("decision")).toBeGreaterThan(kinds.indexOf("turn-open"));
	});

	it("on the standard scaffold, never makes the call and writes no decision", async () => {
		const { sent, entries } = await turn([]);

		expect(sent.some((request) => says(request, DECIDE_INSTRUCTION))).toBe(false);
		expect(sent[0]!.tools.length).toBeGreaterThan(0);
		expect(decisionOf(entries)).toBeUndefined();
	});

	it("goes on without a route when the reply cannot be read, and says so instead of guessing", async () => {
		const { sent, events, entries } = await turn(["I think I should look at my notes first."], "small");

		expect(says(sent[1]!, "You decided this request needs")).toBe(false);
		expect(events.some((event) => event.type === "agent-think" && event.text.startsWith("[decide] no route"))).toBe(true);
		expect(decisionOf(entries)).toBeUndefined();
	});

	it("plans work through the gate before acting, when that is the route", async () => {
		const plan = JSON.stringify([{ tool: "write_file", args: { path: "GAME.md", content: "# Frog" }, note: "the design" }]);
		const { sent, entries } = await turn(['{"route": "work", "why": "three files"}', plan], "small");

		expect(says(sent[1]!, PLAN_INSTRUCTION)).toBe(true);
		expect(sent[1]!.tools).toEqual([]);
		expect(sent[1]!.toolsField).toBe(false);
		// The accepted plan is anchored for the rest of the run.
		expect(says(sent[2]!, "This run is executing the following plan")).toBe(true);
		expect(decisionOf(entries)?.body).toMatchObject({ route: "work" });
	});
});
