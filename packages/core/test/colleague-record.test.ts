/**
 * E87: what the record says about work that crossed into another persona.
 *
 * The decision this row carries is that the record has to name who did the work and under which ceiling, and
 * that the ceiling written down has to be the one that was APPLIED. Before this, the delegation entry copied
 * the asker's photographed posture, so a colleague running under something stricter would have been recorded
 * under the asker's: a record saying something that did not happen, which is the failure the author invariant
 * exists to prevent, committed by the runtime rather than by a persona.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RecordBody } from "../src/record/entry.js";
import { Journal } from "../src/record/journal.js";
import { recordTurns } from "../src/run/recording.js";
import { runnerFor } from "../src/run/runner-for.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

let dir: string;
let personaPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e87-record-"));
	personaPath = join(dir, ".personaxis", "personaxis.md");
	mkdirSync(join(dir, ".personaxis"), { recursive: true });
	writeFileSync(personaPath, "---\npermissions:\n  sandbox: workspace-write\n  approval: never\n---\n# Boss\n\nruns the shop\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A colleague that is stricter than its asker on both axes, so the crossing is something a test can see. */
function strictColleague(address: string): void {
	const folder = join(dir, ".personaxis", "personas", address);
	mkdirSync(folder, { recursive: true });
	writeFileSync(
		join(folder, "personaxis.md"),
		`---\npermissions:\n  sandbox: read-only\n  approval: untrusted\n---\n# ${address}\n\nreads and reports, nothing else\n`,
	);
}

type Call = { name: string; args: Record<string, unknown> };

/** One call per request, then finish, for whoever is asking. */
function scripted(calls: readonly Call[]): typeof fetch {
	let turn = 0;
	return (async (url: string) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		turn += 1;
		const next = calls[turn - 1] ?? { name: "finish", args: { summary: "done" } };
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

async function handOver(args: Record<string, unknown>) {
	const journal = new Journal({});
	await runnerFor(
		{
			personaPath,
			frontmatter: { permissions: { sandbox: "workspace-write", approval: "never" } },
			llm: { endpoint: "http://x/v1", model: "m", fetchImpl: scripted([{ name: "delegate", args }]) } as never,
		},
		{
			policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" },
			observer: recordTurns({ journal }),
		},
	).run({ turn: "t1", prompt: "get it checked", asker: { kind: "human", id: "mara" } });

	return journal.all().map((entry) => entry.body);
}

const delegationIn = (bodies: readonly RecordBody[]) =>
	bodies.find((body): body is Extract<RecordBody, { type: "delegation" }> => body.type === "delegation");

describe("what the record says about work given to a colleague (E87)", () => {
	it("names who it went to", async () => {
		strictColleague("legal");
		const entry = delegationIn(await handOver({ to: "legal", task: "check the wording" }));

		expect(entry?.to).toBe("legal");
		expect(entry?.task).toBe("check the wording");
	});

	it("writes the ceiling that was APPLIED, not the one the asker had", async () => {
		// The asker may write in its workspace and is asked for nothing; the colleague may only read and has to
		// be asked for anything risky. What ran is the stricter of the two, on both axes, and that is what the
		// entry has to say.
		strictColleague("legal");
		const entry = delegationIn(await handOver({ to: "legal", task: "check the wording" }));

		expect(entry?.sandbox).toBe("read-only");
		expect(entry?.approval).toBe("untrusted");
	});

	it("says nothing about a colleague or a crossing when the work stayed in the same persona", async () => {
		// A sub-task of the asker is what delegation always was, and an entry implying a narrowing that never
		// happened would be worse than no entry at all.
		strictColleague("legal");
		const entry = delegationIn(await handOver({ task: "draft the summary" }));

		expect(entry?.to).toBeUndefined();
		expect(entry?.approval).toBeUndefined();
	});
});
