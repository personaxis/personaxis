/**
 * E88: a reflection that ran and kept nothing says so, instead of looking like one that never ran.
 *
 * Measured on 2026-09-16 across four bench runs: the question was asked and nothing was written, and there was
 * no way to tell whether the model had said the method was not worth keeping or had answered something the
 * parser could not read. A persona asked after every hard job that keeps nothing looked exactly like a persona
 * nobody ever asks.
 *
 * The rule is `E85`'s: terminating without verifying has to be an observable state, and so does reflecting
 * without keeping.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RecordBody } from "../src/record/entry.js";
import { openRecord } from "../src/record/index.js";
import { runnerFor } from "../src/run/runner-for.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

let dir: string;
let personaPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e88-silence-"));
	personaPath = join(dir, ".personaxis", "personaxis.md");
	mkdirSync(join(dir, ".personaxis"), { recursive: true });
	writeFileSync(
		personaPath,
		"---\npermissions:\n  sandbox: workspace-write\n  approval: never\nimprovement_policy:\n  mode: suggesting\n---\n# Boss\n\nruns the shop\n",
	);
	writeFileSync(join(dir, ".personaxis", "state.json"), JSON.stringify({ version: 1, coordinates: {} }));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Call = { name: string; args: Record<string, unknown> };

/** Works through the script, then answers the lesson question with whatever `said` is. */
function scripted(said: string): typeof fetch {
	let turn = 0;
	const work: Call[] = ["a", "b", "c", "d"].map((n) => ({ name: "write_file", args: { path: `${n}.txt`, content: n } }));
	return (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		const sent = JSON.parse(init?.body ?? "{}") as { tools?: unknown[] };
		if ((sent.tools ?? []).length === 0) {
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: said }, finish_reason: "stop" }] }) };
		}
		turn += 1;
		const next = work[turn - 1] ?? { name: "finish", args: { summary: "done" } };
		return {
			ok: true,
			status: 200,
			json: async () => ({
				choices: [
					{
						message: { content: "", tool_calls: [{ id: `c${turn}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] },
						finish_reason: "tool_calls",
					},
				],
			}),
		};
	}) as unknown as typeof fetch;
}

async function turn(said: string) {
	await runnerFor(
		{
			personaPath,
			frontmatter: { permissions: { sandbox: "workspace-write", approval: "never" } },
			llm: { endpoint: "http://x/v1", model: "m", fetchImpl: scripted(said) } as never,
		},
		{ policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" } },
	).run({ turn: "t1", prompt: "sort out the build", asker: { kind: "human", id: "david" } });
}

const bodies = (): RecordBody[] => openRecord(personaPath).all().map((entry) => entry.body);
const reflection = () => bodies().find((body): body is Extract<RecordBody, { type: "reflection" }> => body.type === "reflection");
const drafts = (): string[] => {
	const at = join(dir, ".personaxis", "skills", "pending");
	return existsSync(at) ? readdirSync(at).filter((f) => f.endsWith(".md")) : [];
};

describe("a reflection that kept nothing (E88)", () => {
	it("says so when the persona answered that the method was not worth keeping", async () => {
		await turn(JSON.stringify({ reusable: false, name: "x", body: "y" }));

		expect(drafts()).toEqual([]);
		expect(reflection()?.reason).toContain("no reusable lesson");
		expect(reflection()?.from).toContain("sort out the build");
	});

	it("says so when the answer could not be read at all, which is a different thing from saying no", async () => {
		// The two were indistinguishable in the bench, and that is what this row set out to fix.
		await turn("I think we learned a lot today");

		expect(drafts()).toEqual([]);
		expect(reflection()).toBeTruthy();
	});

	it("writes no such entry when a method WAS kept, because then the skill entry is the record", async () => {
		await turn(JSON.stringify({ reusable: true, name: "Fix a crashing page", description: "d", capabilities: ["c"], allowed_tools: ["read_file"], body: "1. Run it." }));

		expect(drafts()).toEqual(["fix-a-crashing-page.md"]);
		expect(reflection()).toBeUndefined();
		expect(bodies().some((body) => body.type === "skill")).toBe(true);
	});
});
