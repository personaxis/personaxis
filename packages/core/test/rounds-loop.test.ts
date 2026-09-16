/**
 * E86 inside a real turn: a long job hands one task to a fresh context, and only the answer comes back.
 *
 * The parent and the sub-task both talk to the same scripted model here, which is what makes the central claim
 * testable at all: the reply is chosen by looking at what each one was SENT, so the child's working-out exists,
 * is real, and can be searched for in the parent's requests. If it ever leaks, this fails.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RecordBody } from "../src/record/entry.js";
import { Journal } from "../src/record/journal.js";
import { recordTurns } from "../src/run/recording.js";
import { runnerFor } from "../src/run/runner-for.js";
import { ROUND_LIST_FLOOR } from "../src/run/rounds.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e86-loop-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Call = { name: string; args: Record<string, unknown> };
type Sent = Array<{ role: string; content?: unknown }>;

/** The first words of the brief, which is how a request from a round is told apart from one from the parent. */
const BRIEF_MARK = "You are doing one task of a longer job";
/** Something only the sub-task's own transcript ever contains. */
const SCRATCH = "CHILD-SCRATCH-that-must-never-reach-the-parent";
const DONE = "level two is in place, and I ran it";

/** Six things to do, which is the size at which a job stops fitting in one context. */
const SIX_TASKS: Call = {
	name: "update_tasks",
	args: {
		tasks: [
			{ text: "draw level two", status: "in_progress" },
			...Array.from({ length: ROUND_LIST_FLOOR - 1 }, (_, i) => ({ text: `step ${i}`, status: "pending" })),
		],
	},
};

/**
 * A model that answers the parent from a script and the sub-task from another, telling them apart by what it
 * was sent, and keeping every request the PARENT made.
 */
function scripted(parent: readonly Call[]): { fetchImpl: typeof fetch; parentSent: Sent[]; briefs: string[] } {
	const parentSent: Sent[] = [];
	const briefs: string[] = [];
	let parentTurn = 0;
	let childTurn = 0;

	const reply = (turn: number, call: Call) => ({
		ok: true,
		status: 200,
		json: async () => ({
			choices: [
				{
					message: { content: "", tool_calls: [{ id: `c${turn}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] },
					finish_reason: "tool_calls",
				},
			],
		}),
	});

	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		const messages = (JSON.parse(init?.body ?? "{}") as { messages?: Sent }).messages ?? [];
		const whole = messages.map((message) => String(message.content ?? "")).join("\n");

		if (whole.includes(BRIEF_MARK)) {
			childTurn += 1;
			if (childTurn === 1) briefs.push(String(messages.find((message) => String(message.content ?? "").includes(BRIEF_MARK))?.content ?? ""));
			// Working-out first, then the answer: the working-out is the part that must not cross back.
			return childTurn === 1
				? reply(childTurn, { name: "write_file", args: { path: "level-two.html", content: `<html><body><script>/* ${SCRATCH} */</script></body></html>` } })
				: reply(childTurn, { name: "finish", args: { summary: DONE } });
		}

		parentSent.push(messages);
		parentTurn += 1;
		return reply(parentTurn, parent[parentTurn - 1] ?? { name: "finish", args: { summary: "the job is done" } });
	}) as unknown as typeof fetch;

	return { fetchImpl, parentSent, briefs };
}

async function turn(options: { rounds?: boolean; sandbox?: string; script?: readonly Call[] } = {}) {
	const model = scripted(options.script ?? [SIX_TASKS]);
	const journal = new Journal({});
	const outcome = await runnerFor(
		{
			personaPath: join(dir, ".personaxis", "personaxis.md"),
			frontmatter: { permissions: { sandbox: options.sandbox ?? "workspace-write", approval: "never" } },
			llm: { endpoint: "http://x/v1", model: "m", fetchImpl: model.fetchImpl, ...(options.rounds === undefined ? {} : { rounds: options.rounds }) } as never,
		},
		{
			policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" },
			observer: recordTurns({ journal }),
		},
	).run({ turn: "t1", prompt: "build the whole arcade game", asker: { kind: "human", id: "david" } });

	return { outcome, parentSent: model.parentSent, briefs: model.briefs, bodies: journal.all().map((entry) => entry.body) };
}

describe("a long job in rounds of fresh context (E86)", () => {
	it("hands the task the run is on to a round once the list has grown", async () => {
		const { outcome } = await turn({ rounds: true });

		expect(outcome.rounds).toHaveLength(1);
		expect(outcome.rounds?.[0]).toMatchObject({ task: "draw level two", because: "list" });
	});

	it("gives the round a brief built from the state, not from the parent's account of itself", async () => {
		const { briefs } = await turn({ rounds: true });

		expect(briefs[0]).toContain("The job: build the whole arcade game");
		expect(briefs[0]).toContain("Your task, and the only one: draw level two");
		// E84 crossing the boundary: a sub-task has nobody to ask, and must say what is missing rather than invent.
		expect(briefs[0]).toContain("Nobody can be asked anything from here");
	});

	it("brings back the answer and nothing else, which is the whole point of a fresh context", async () => {
		const { outcome, parentSent } = await turn({ rounds: true });

		const afterTheRound = parentSent.at(-1)!.map((message) => String(message.content ?? "")).join("\n");
		expect(afterTheRound).toContain(DONE);
		expect(afterTheRound).not.toContain(SCRATCH);
		expect(outcome.rounds?.[0]?.reply).toContain(DONE);
	});

	it("writes the round into the record, because a round nobody can see is work nobody can audit", async () => {
		const { bodies } = await turn({ rounds: true });

		const round = bodies.find((body): body is Extract<RecordBody, { type: "round" }> => body.type === "round");
		expect(round?.rounds[0]).toMatchObject({ task: "draw level two", because: "list" });
		expect(round?.rounds[0]?.reply).toContain(DONE);
	});

	it("opens no round when the settings never asked for one, which is every run until somebody does", async () => {
		const { outcome, briefs } = await turn();

		expect(outcome.rounds).toBeUndefined();
		expect(briefs).toEqual([]);
	});

	it("opens no round for a persona that was never offered delegation, and the turn goes on as before", async () => {
		// A read-only persona is not shown `delegate` at all: not about authority, about spend. With no way to
		// hand work down there are no rounds, and nothing else about the turn changes.
		const { outcome, briefs } = await turn({ rounds: true, sandbox: "read-only" });

		expect(outcome.rounds).toBeUndefined();
		expect(briefs).toEqual([]);
		expect(outcome.stopReason).toBe("answered");
	});

	it("opens no round for a job the list says is short, however the model is configured", async () => {
		const short: Call = { name: "update_tasks", args: { tasks: [{ text: "draw level two", status: "in_progress" }] } };
		const { outcome } = await turn({ rounds: true, script: [short] });

		expect(outcome.rounds).toBeUndefined();
	});
});
