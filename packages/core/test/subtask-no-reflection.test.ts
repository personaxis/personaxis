/**
 * E88: only the run somebody asked for learns from itself.
 *
 * Decided on 2026-09-16 while wiring it, and written here because a decision nothing watches is a decision
 * that quietly stops being true. `agentOptionsFor` builds the options for EVERY run and `subTaskSession`
 * carries them through, so without the depth check a round (`E86`) or a colleague (`E87`) would write skills
 * of its own: one turn could leave several, each abstracted from a piece nobody asked about on its own.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runnerFor } from "../src/run/runner-for.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

let dir: string;
let personaPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e88-sub-"));
	personaPath = join(dir, ".personaxis", "personaxis.md");
	mkdirSync(join(dir, ".personaxis"), { recursive: true });
	writeFileSync(
		personaPath,
		"---\npermissions:\n  sandbox: workspace-write\n  approval: never\nimprovement_policy:\n  mode: suggesting\n---\n# Boss\n\nruns the shop\n",
	);
	writeFileSync(join(dir, ".personaxis", "state.json"), JSON.stringify({ version: 1, coordinates: {} }));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const LESSON = JSON.stringify({ reusable: true, name: "Fix a crashing page", description: "d", capabilities: ["c"], allowed_tools: ["read_file"], body: "1. Run it." });

type Call = { name: string; args: Record<string, unknown> };

/** Works through the script, and would answer the lesson question if it were ever asked. */
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

/** Four real steps, which is what the product itself calls hard (`shouldRunPostmortem`). */
const HARD: Call[] = ["a", "b", "c", "d"].map((n) => ({ name: "write_file", args: { path: `${n}.txt`, content: n } }));

async function turn(depth?: number) {
	await runnerFor(
		{
			personaPath,
			frontmatter: { permissions: { sandbox: "workspace-write", approval: "never" } },
			llm: { endpoint: "http://x/v1", model: "m", fetchImpl: scripted(HARD) } as never,
		},
		{
			policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" },
			...(depth === undefined ? {} : { delegationDepth: depth }),
		},
	).run({ turn: "t1", prompt: "sort out the build", asker: { kind: "human", id: "mara" } });
}

const drafts = (): string[] => {
	const at = join(dir, ".personaxis", "skills", "pending");
	return existsSync(at) ? readdirSync(at).filter((f) => f.endsWith(".md")) : [];
};

describe("which run learns from itself (E88)", () => {
	it("the run somebody asked for does, which is the control of the control", async () => {
		// Without this, the refusal below could be the reflection being off everywhere.
		await turn();

		expect(drafts()).toEqual(["fix-a-crashing-page.md"]);
	});

	it("a delegated sub-task does not, however hard its own work was", async () => {
		await turn(1);

		expect(drafts()).toEqual([]);
	});
});
