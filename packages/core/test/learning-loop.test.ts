/**
 * E88 inside a real turn: a hard-won piece of work leaves a skill, governed, with its provenance in the record.
 *
 * The three cases the row asks for, and they are three different claims: a hard run leaves a draft a person
 * still has to approve; a trivial one leaves nothing, because a method that fits one job is a note about that
 * job; and a persona that never asked for this leaves nothing either, however hard the work was.
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

/** The persona, with the improvement policy this case is about. */
function persona(mode: string): void {
	dir = mkdtempSync(join(tmpdir(), "pxs-e88-loop-"));
	personaPath = join(dir, ".personaxis", "personaxis.md");
	mkdirSync(join(dir, ".personaxis"), { recursive: true });
	writeFileSync(
		personaPath,
		`---\npermissions:\n  sandbox: workspace-write\n  approval: never\nimprovement_policy:\n  mode: ${mode}\n---\n# Boss\n\nruns the shop\n`,
	);
	writeFileSync(join(dir, ".personaxis", "state.json"), JSON.stringify({ version: 1, coordinates: {} }));
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const LESSON = JSON.stringify({
	reusable: true,
	name: "Fix a crashing page",
	description: "when a page dies a few seconds in",
	capabilities: ["debugging a browser game"],
	allowed_tools: ["read_file"],
	body: "1. Run the page.\n2. Read the first error.\n3. Fix the call it names.",
});

type Call = { name: string; args: Record<string, unknown> };

/**
 * A model that works through a script and then answers the lesson question.
 *
 * The reflection is one call with no tools, so it is told apart by that: whatever arrives with an empty tool
 * list after the work is the question about method.
 */
function scripted(work: readonly Call[]): typeof fetch {
	let turn = 0;
	return (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		const sent = JSON.parse(init?.body ?? "{}") as { tools?: unknown[] };
		if ((sent.tools ?? []).length === 0) {
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: LESSON }, finish_reason: "stop" }] }) };
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

/** Four real steps: `shouldRunPostmortem` calls that hard, which is the product's own definition. */
const HARD: Call[] = [
	{ name: "write_file", args: { path: "a.txt", content: "1" } },
	{ name: "write_file", args: { path: "b.txt", content: "2" } },
	{ name: "write_file", args: { path: "c.txt", content: "3" } },
	{ name: "write_file", args: { path: "d.txt", content: "4" } },
];

async function turn(work: readonly Call[]) {
	await runnerFor(
		{
			personaPath,
			frontmatter: { permissions: { sandbox: "workspace-write", approval: "never" } },
			llm: { endpoint: "http://x/v1", model: "m", fetchImpl: scripted(work) } as never,
		},
		{ policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" } },
	).run({ turn: "t1", prompt: "sort out the build", asker: { kind: "human", id: "david" } });
}

/** The drafts on disk, which is what "a person still has to approve it" means in files. */
const pending = (): string[] => {
	const at = join(dir, ".personaxis", "skills", "pending");
	return existsSync(at) ? readdirSync(at).filter((f) => f.endsWith(".md")) : [];
};

const active = (): string[] => {
	const at = join(dir, ".personaxis", "skills");
	return existsSync(at) ? readdirSync(at).filter((f) => f.endsWith(".md")) : [];
};

/** The provenance entry, read back out of the persona's own record. */
function skillEntry(): Extract<RecordBody, { type: "skill" }> | undefined {
	const record = openRecord(personaPath);
	return record
		.all()
		.map((entry) => entry.body)
		.find((body): body is Extract<RecordBody, { type: "skill" }> => body.type === "skill");
}

describe("a hard-won run leaves a skill, governed (E88)", () => {
	it("queues a draft a person still has to approve, and never activates it", async () => {
		persona("suggesting");
		await turn(HARD);

		expect(pending()).toEqual(["fix-a-crashing-page.md"]);
		expect(active()).toEqual([]);
	});

	it("writes the provenance, so the method can be read against the job that taught it", async () => {
		persona("suggesting");
		await turn(HARD);

		expect(skillEntry()).toMatchObject({ type: "skill", name: "fix-a-crashing-page", outcome: "queued" });
		expect(skillEntry()?.from).toContain("sort out the build");
		expect(skillEntry()?.hash).toBeTruthy();
	});

	it("leaves nothing after a one-shot job, because that method is a note about that job", async () => {
		persona("suggesting");
		await turn([{ name: "write_file", args: { path: "a.txt", content: "1" } }]);

		expect(pending()).toEqual([]);
		expect(skillEntry()).toBeUndefined();
	});

	it("leaves nothing for a persona that never asked for this, however hard the work was", async () => {
		persona("locked");
		await turn(HARD);

		expect(pending()).toEqual([]);
		expect(active()).toEqual([]);
	});
});
