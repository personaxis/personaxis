/**
 * E99 inside a real turn: a sub-task that works and then goes silent hands its parent the facts, not silence.
 *
 * The shape measured on 2026-09-16 in the colleague runs of `E87`, reproduced here with a scripted model: the
 * child makes a real call, then returns twice with no text and no action. The loop ends that turn through the
 * ordinary completion path on purpose, because a person watching the TUI already saw the work; one boundary
 * away, the parent sees only the answer, and the answer was empty.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runnerFor } from "../src/run/runner-for.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

let dir: string;
let personaPath: string;

/** In the colleague's own document, so its requests are recognisable and the child is described as itself. */
const PURPOSE = "reads a page and reports what it found";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e99-"));
	personaPath = join(dir, ".personaxis", "personaxis.md");
	mkdirSync(join(dir, ".personaxis"), { recursive: true });
	writeFileSync(personaPath, "---\npermissions:\n  sandbox: workspace-write\n  approval: never\n---\n# Boss\n\nruns the shop\n");
	const colleague = join(dir, ".personaxis", "personas", "reader");
	mkdirSync(colleague, { recursive: true });
	writeFileSync(
		join(colleague, "personaxis.md"),
		`---\npermissions:\n  sandbox: read-only\n  approval: on-failure\n---\n# reader\n\n${PURPOSE}\n`,
	);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Sent = Array<{ role: string; content?: unknown }>;

/**
 * The asker hands work over; the colleague makes one real call and then says nothing, twice.
 *
 * Told apart by what each was sent, which is the only way to be sure the silence belongs to the child.
 */
function scripted(): { fetchImpl: typeof fetch; parentSent: Sent[] } {
	const parentSent: Sent[] = [];
	let childTurn = 0;

	const call = (id: string, name: string, args: Record<string, unknown>) => ({
		ok: true,
		status: 200,
		json: async () => ({
			choices: [{ message: { content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
		}),
	});
	const silence = () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }) });

	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		const messages = (JSON.parse(init?.body ?? "{}") as { messages?: Sent }).messages ?? [];
		const whole = messages.map((message) => String(message.content ?? "")).join("\n");

		if (whole.includes(PURPOSE)) {
			childTurn += 1;
			// One real call, then nothing at all, twice: the shape three of four colleagues produced.
			return childTurn === 1 ? call("k1", "list_dir", { path: "." }) : silence();
		}

		parentSent.push(messages);
		return parentSent.length === 1
			? call("p1", "delegate", { to: "reader", task: "go over the page" })
			: call("p2", "finish", { summary: "handed over" });
	}) as unknown as typeof fetch;

	return { fetchImpl, parentSent };
}

async function turn() {
	const model = scripted();
	const outcome = await runnerFor(
		{
			personaPath,
			frontmatter: { permissions: { sandbox: "workspace-write", approval: "never" } },
			llm: { endpoint: "http://x/v1", model: "m", fetchImpl: model.fetchImpl } as never,
		},
		{ policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" } },
	).run({ turn: "t1", prompt: "get the page looked at", asker: { kind: "human", id: "mara" } });

	return { outcome, parentSent: model.parentSent };
}

describe("a sub-task that worked and said nothing (E99)", () => {
	it("hands the parent what it did, instead of nothing", async () => {
		const { parentSent } = await turn();

		const back = parentSent.at(-1)!.map((message) => String(message.content ?? "")).join("\n");
		expect(back).toContain("finished without writing an answer");
		expect(back).toContain("list_dir");
	});

	it("does not tell the parent a summary the colleague never wrote", async () => {
		// Facts the runtime already held, and nothing else: a sentence invented on the persona's behalf and
		// handed up as its answer is the forgery the author invariant exists to prevent.
		const { parentSent } = await turn();

		const back = parentSent.at(-1)!.map((message) => String(message.content ?? "")).join("\n");
		expect(back).toContain("from the runtime's own record of this turn");
	});
});
