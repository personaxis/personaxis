/**
 * E86: a declared context window, and the guard that keeps discovery from undoing it.
 *
 * ## Why the row needed this at all
 *
 * The rounds of fresh context were built, committed, and never once seen to fire. Measured on 2026-09-16 over
 * eight real runs: with `long-job`, Qwen filled 5.800 tokens of 32.768 and Cohere far less of 256.000, so the
 * 0,8 threshold was never approached. David chose, on 2026-09-17, to declare a smaller window in the bench
 * rather than manufacture a job big enough to fill a real one. A small window is not a laboratory trick:
 * small models genuinely have them.
 *
 * ## Three earlier shapes of this test were wrong, and that is why it looks like this
 *
 * The first built a `ContextMeter` by hand. It passed, and would have kept passing with the guard deleted,
 * because it never touched the line that does the work. The second filled the context with a huge `write_file`
 * argument: arguments are not message content, and `write_file` answers with a short confirmation. The third
 * read a huge file: every tool result at or above 4.000 characters is replaced by an 800-character preview
 * (`tool-output-store.ts`), on purpose, so one big file cannot flood a transcript.
 *
 * David then pointed out the thing that removes the whole problem: filling to 80% is only what triggers an
 * AUTOMATIC compaction, and the same decision can be reached by lowering the threshold. So this asks for a low
 * threshold and lets the turn's own real work supply the context, instead of fabricating filler that the loop
 * was designed not to count.
 *
 * ## What each case is for
 *
 * The declared window and the discovered one both open a round under a low threshold, so "a round opened" on
 * its own cannot tell them apart. The case that fails when the guard is deleted is the one about the endpoint
 * never being asked: discovery is exactly what a declaration overrides.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runnerFor } from "../src/run/runner-for.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e86-window-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Small enough that ordinary work fills it, and a real size for a small local model. */
const DECLARED = 8_192;

type Sent = Array<{ role: string; content?: unknown }>;

/** The parent reads its notes, then finishes. The read is what puts real work in the context. */
function scripted(): { fetchImpl: typeof fetch; askedModels: () => number; parentSteps: () => number } {
	let models = 0;
	let parentTurn = 0;

	const toolCall = (id: string, name: string, args: unknown) => ({
		ok: true,
		status: 200,
		json: async () => ({
			choices: [{ message: { content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
		}),
	});

	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) {
			models += 1;
			return { ok: true, status: 200, json: async () => ({ data: [] }) };
		}
		const messages = (JSON.parse(init?.body ?? "{}") as { messages?: Sent }).messages ?? [];
		const whole = messages.map((message) => String(message.content ?? "")).join("\n");
		// A round's sub-task is told it has none of this turn's history. Answer briefly and be done.
		if (whole.includes("in a context that has none of its history")) return toolCall("child", "finish", { summary: "done in a fresh context" });

		parentTurn += 1;
		return parentTurn === 1 ? toolCall("p1", "read_file", { path: "notes.md" }) : toolCall(`p${parentTurn}`, "finish", { summary: "the job is done" });
	}) as unknown as typeof fetch;

	return { fetchImpl, askedModels: () => models, parentSteps: () => parentTurn };
}

async function turn(options: { contextWindow?: number; threshold: number }) {
	// Real work, not filler: a note the persona reads, well under the offload threshold so it is counted.
	writeFileSync(join(dir, "notes.md"), "the level design, at length. ".repeat(40), "utf-8");
	const model = scripted();
	const outcome = await runnerFor(
		{
			personaPath: join(dir, ".personaxis", "personaxis.md"),
			frontmatter: { permissions: { sandbox: "workspace-write", approval: "never" } },
			// No meter is passed: a caller declares the window on the model and the loop builds its meter from
			// it. Passing one would bypass the declaration and test nothing about it.
			llm: { endpoint: "http://x/v1", model: "m", fetchImpl: model.fetchImpl, rounds: true, ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }) } as never,
		},
		{
			policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" },
			compactThreshold: options.threshold,
		},
	).run({ turn: "t1", prompt: "write up the whole arcade game", asker: { kind: "human", id: "david" } });

	return { outcome, askedModels: model.askedModels(), parentSteps: model.parentSteps() };
}

describe("a context window declared instead of discovered (E86)", () => {
	it("never asks the endpoint how big the window is, because that is what it overrides", async () => {
		// THE case: discovery lands mid-turn and assigns `meter.limit`, so asking at all is the bug. Delete the
		// guard in `agent.ts` and this goes red while everything else here stays green.
		const { askedModels } = await turn({ contextWindow: DECLARED, threshold: 0.01 });

		expect(askedModels).toBe(0);
	});

	it("still asks when nobody declared one, which is the ordinary path and must keep working", async () => {
		const { askedModels } = await turn({ threshold: 0.01 });

		expect(askedModels).toBe(1);
	});

	it("opens a round from the context signal with a window declared, on the turn's own work", async () => {
		// No filler: the turn reads a note and that is the context. The threshold is what decides, which is
		// David's point on 2026-09-17: filling to 0,8 is only what makes the decision happen by itself.
		const { outcome, parentSteps } = await turn({ contextWindow: DECLARED, threshold: 0.01 });

		expect(parentSteps).toBeGreaterThanOrEqual(2);
		expect(outcome.rounds ?? []).toHaveLength(1);
		// By the context and not by a list: this turn keeps none, which is what every real run also did.
		expect(outcome.rounds?.[0]).toMatchObject({ because: "context" });
	});

	it("opens none when the context is nowhere near the threshold, declared window or not", async () => {
		const { outcome } = await turn({ contextWindow: DECLARED, threshold: 0.99 });

		expect(outcome.rounds ?? []).toHaveLength(0);
	});
});
