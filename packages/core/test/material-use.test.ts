/**
 * E80: a persona's use of its own material is written in the record, and nothing else is.
 *
 * Run through `runnerFor`, with a scripted model and the record observer, so what is checked is what a
 * turn in the TUI, an editor over ACP or a service step writes down: the same assembly, the same gate,
 * the same entries.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compactionPlan } from "../src/compaction/units.js";
import type { RecordBody } from "../src/record/entry.js";
import { Journal } from "../src/record/journal.js";
import { skillFingerprint } from "../src/run/local-skills.js";
import { recordTurns } from "../src/run/recording.js";
import { runnerFor } from "../src/run/runner-for.js";
import { TurnRunner } from "../src/run/service.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

type CallBody = Extract<RecordBody, { type: "call" }>;
type Scripted = { name: string; args: Record<string, unknown> };

let workspace: string;
let folder: string;
let personaPath: string;

function write(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

/** On-request, the posture that asks a person about anything that is not a known read. */
const FRONTMATTER = {
	extensions: { skills: ["./skills/game-feel"] },
	permissions: { sandbox: "workspace-write", approval: "on-request" },
};

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "pxs-material-"));
	folder = join(workspace, ".personaxis", "personas", "gamewright");
	personaPath = join(folder, "personaxis.md");
	write(personaPath, '---\nextensions:\n  skills:\n    - "./skills/game-feel"\npermissions:\n  sandbox: workspace-write\n  approval: on-request\n---\n');
	write(join(folder, "skills", "game-feel", "SKILL.md"), "---\nname: game-feel\ndescription: Make actions feel responsive.\n---\n\nStart hit-stop at 60 ms.\n");
	write(join(folder, "references", "web-research.md"), "# What was read on the web\n\nJump buffering: 100 ms.\n");
	write(join(folder, "examples", "cat-game.md"), "# A finished design\n");
	write(join(workspace, "notes.md"), "# Project notes\n");
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

/** A model that makes the given calls, one per step, and then finishes. */
function scripted(calls: readonly Scripted[]): typeof fetch {
	let turn = 0;
	return (async (url: string) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		turn += 1;
		const next = calls[turn - 1] ?? { name: "finish", args: { summary: "done" } };
		const call = { id: `c${turn}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } };
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", tool_calls: [call] } }] }) };
	}) as unknown as typeof fetch;
}

/** The turn run for real, nobody there to approve anything, and the record it leaves. */
async function recorded(calls: readonly Scripted[]): Promise<Journal> {
	const journal = new Journal({});
	await runnerFor(
		{ personaPath, frontmatter: FRONTMATTER, llm: { endpoint: "http://model.invalid/v1", model: "m", fetchImpl: scripted(calls) } },
		{
			policy: { ...DEFAULT_POLICY, workspaceRoot: workspace, sandbox: "workspace-write", approval: "on-request", resourceRoots: [folder, workspace] },
			observer: recordTurns({ journal }),
		},
	).run({ turn: "t1", prompt: "design the cat game", asker: { kind: "human", id: "david" } });
	return journal;
}

function callsIn(journal: Journal): CallBody[] {
	return journal
		.all()
		.map((entry) => entry.body)
		.filter((body): body is CallBody => body.type === "call");
}

describe("what a turn used of the persona's own material (E80)", () => {
	it("writes the reference it read and the skill it loaded, with the skill's version, and nothing for a project file", async () => {
		const calls = callsIn(
			await recorded([
				{ name: "read_file", args: { path: ".personaxis/personas/gamewright/references/web-research.md" } },
				{ name: "read_file", args: { path: "notes.md" } },
				{ name: "use_skill", args: { name: "game-feel" } },
				// Relative to the persona's own folder, which is how a compiled persona names its files.
				{ name: "read_file", args: { path: "examples/cat-game.md" } },
			]),
		);

		expect(calls.map((call) => [call.tool, call.verdict])).toEqual([
			["read_file", "allowed"],
			["read_file", "allowed"],
			// Nobody is there to approve, so a skill load that asked would be written as refused.
			["use_skill", "allowed"],
			["read_file", "allowed"],
		]);
		expect(calls[0]!.used).toEqual({ kind: "reference", name: ".personaxis/personas/gamewright/references/web-research.md" });
		expect(calls[1]!.used).toBeUndefined();
		expect(calls[2]!.used).toEqual({
			kind: "skill",
			name: "game-feel",
			version: skillFingerprint(readFileSync(join(folder, "skills", "game-feel", "SKILL.md"), "utf8")),
		});
		expect(calls[3]!.used).toEqual({ kind: "example", name: ".personaxis/personas/gamewright/examples/cat-game.md" });
	});

	it("writes a refused call with its reason and no use, because nothing was read", async () => {
		const journal = await recorded([{ name: "read_file", args: { path: "../another-client/contract.md" } }]);
		const [refused] = callsIn(journal);

		expect(refused!.verdict).toBe("denied");
		expect(refused!.reason).toContain("nobody to ask");
		expect(refused!.used).toBeUndefined();
		// The fold that counts refusals had nothing to count until calls were written.
		const state = journal.state();
		expect(state.ok && state.state.denialCount).toBe(1);
	});

	it("does not call a read of a reference that is not there a use", async () => {
		const [missing] = callsIn(await recorded([{ name: "read_file", args: { path: ".personaxis/personas/gamewright/references/not-written.md" } }]));

		expect(missing!.verdict).toBe("allowed");
		expect(missing!.used).toBeUndefined();
	});
});

describe("where calls land in a turn's record (E80)", () => {
	it("after what was asked and before the answer, attributed to the gate", async () => {
		const journal = new Journal({});
		await new TurnRunner({
			provider: {
				name: "scripted",
				run: async () => ({
					answer: "done",
					steps: 2,
					calls: [
						{ callId: "a", tool: "read_file", verdict: "allowed", step: 1, used: { kind: "reference", name: "r.md" } },
						{ callId: "b", tool: "write_file", verdict: "denied", reason: "outside", step: 2 },
					],
				}),
			},
			observer: recordTurns({ journal }),
		}).run({ turn: "t1", prompt: "go", asker: { kind: "human", id: "david" } });

		const entries = journal.all();
		expect(entries.map((entry) => entry.body.type)).toEqual(["turn-open", "call", "call", "message", "turn-close"]);
		expect(entries[1]!.body).toEqual({ type: "call", turn: "t1", callId: "a", tool: "read_file", verdict: "allowed", used: { kind: "reference", name: "r.md" } });
		expect(entries[2]!.body).toEqual({ type: "call", turn: "t1", callId: "b", tool: "write_file", verdict: "denied", reason: "outside" });
		// The verdict is the gate's, not the persona's.
		expect(entries[1]!.author).toMatchObject({ kind: "runtime", mechanism: "gate" });
	});

	it("in the order they happened around a compaction: taken before its step, so before that step's calls", async () => {
		const journal = new Journal({});
		const plan = compactionPlan({ kept: [], summarised: [], before: 900, after: 300 });
		await new TurnRunner({
			provider: {
				name: "scripted",
				run: async () => ({
					answer: "done",
					steps: 2,
					compactions: [{ why: "window-full at step 2", plan, step: 2 }],
					calls: [
						{ callId: "a", tool: "read_file", verdict: "allowed", step: 1 },
						{ callId: "b", tool: "read_file", verdict: "allowed", step: 2 },
					],
				}),
			},
			observer: recordTurns({ journal }),
		}).run({ turn: "t1", prompt: "go", asker: { kind: "human", id: "david" } });

		const order = journal.all().map((entry) => (entry.body.type === "call" ? `call ${entry.body.callId}` : entry.body.type));
		// A compaction writes a `failure` body (`compaction/measured.ts`).
		expect(order).toEqual(["turn-open", "call a", "failure", "call b", "message", "turn-close"]);
	});
});
