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

import { ContextMeter } from "../src/context.js";
import type { RecordBody } from "../src/record/entry.js";
import { Journal } from "../src/record/journal.js";
import { recordTurns } from "../src/run/recording.js";
import { runnerFor } from "../src/run/runner-for.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e86-loop-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Call = { name: string; args: Record<string, unknown> };
type Sent = Array<{ role: string; content?: unknown }>;

/**
 * A sentence both shapes of the brief carry, which is how a request from a round is told apart from the
 * parent's. Not the opening words: a round with no listed task opens differently, and anchoring on the opening
 * would have made this test blind to exactly the case that was added after the first measurement.
 */
const BRIEF_MARK = "in a context that has none of its history";
/** Something only the sub-task's own transcript ever contains. */
const SCRATCH = "CHILD-SCRATCH-that-must-never-reach-the-parent";
const DONE = "level two is in place, and I ran it";

/** Six things to do, which is the size at which a job stops fitting in one context. */
const SIX_TASKS: Call = {
	name: "update_tasks",
	args: {
		tasks: [
			{ text: "draw level two", status: "in_progress" },
			// Five more, so the list holds six: the floor lives in `rounds.ts` and is internal, so it is spelled
			// out here rather than reached for.
			...Array.from({ length: 5 }, (_, i) => ({ text: `step ${i}`, status: "pending" })),
		],
	},
};

/**
 * A model that answers the parent from a script and the sub-task from another, telling them apart by what it
 * was sent, and keeping every request the PARENT made.
 */
function scripted(parent: readonly Call[], afterFirstParent?: () => void): { fetchImpl: typeof fetch; parentSent: Sent[]; briefs: string[] } {
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
		// After the first request and before the second step, which is where a context that filled while the
		// work was happening is noticed.
		if (parentTurn === 1) afterFirstParent?.();
		return reply(parentTurn, parent[parentTurn - 1] ?? { name: "finish", args: { summary: "the job is done" } });
	}) as unknown as typeof fetch;

	return { fetchImpl, parentSent, briefs };
}

async function turn(options: { rounds?: boolean; sandbox?: string; script?: readonly Call[]; meter?: ContextMeter; fillTo?: number } = {}) {
	const { meter, fillTo } = options;
	// An absolute fill, against a window the test pins to the one the loop will resolve anyway. Computing it
	// from the limit of the moment did not work: the loop resolves the real window in the background, and for
	// an unknown model that is the table's 32768, so a fill measured against a smaller number became a trickle
	// as soon as the resolution landed. Pinning both sides makes the outcome the same whichever order they
	// happen in, which is what a test of a threshold needs.
	const model = scripted(options.script ?? [SIX_TASKS], meter && fillTo !== undefined ? () => (meter.used = fillTo) : undefined);
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
			...(meter === undefined ? {} : { meter }),
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

	it("opens a round on a filling context even when the persona kept no list", async () => {
		// The case the first measurement exposed: on 2026-09-16, across eight runs, neither model wrote a list
		// at all, so a context signal that needed a listed task could never fire. The window fills after the
		// first request, which is also what keeps the turn-start compaction, a step-one thing, out of the way.
		// The window the loop resolves for a model it does not know, pinned here so both sides agree, and a fill
		// of about 0.915 of it: above the 0.8 that opens a round, below the 0.92 that rewrites the transcript.
		const meter = new ContextMeter(32_768);
		const { outcome, briefs } = await turn({
			rounds: true,
			script: [{ name: "write_file", args: { path: "notes.md", content: "# notes" } }],
			meter,
			fillTo: 30_000,
		});

		expect(outcome.rounds).toHaveLength(1);
		expect(outcome.rounds?.[0]).toMatchObject({ task: "what is left of the job", because: "context" });
		expect(briefs[0]).toContain("Your task: finish what this job still needs.");
	});

	it("opens no round for a job the list says is short, however the model is configured", async () => {
		const short: Call = { name: "update_tasks", args: { tasks: [{ text: "draw level two", status: "in_progress" }] } };
		const { outcome } = await turn({ rounds: true, script: [short] });

		expect(outcome.rounds).toBeUndefined();
	});
});
