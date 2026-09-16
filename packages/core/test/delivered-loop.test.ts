/**
 * E85 inside a real turn: what the persona left is checked before the turn says it is done, the check lands in
 * the record, and what has no obvious check is named rather than passed over.
 *
 * The persona here declares no `verification:` block, which is every persona in this project today. That is the
 * case that matters: if this only ran for a persona that declared gates, the row would ship switched off.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compile, DEFAULT_POLICY, PersonaAgent, policyFromPersona } from "../src/index.js";
import { Journal } from "../src/record/journal.js";
import { defaultLoop } from "../src/run/default-provider.js";
import { recordTurns } from "../src/run/recording.js";
import { TurnRunner } from "../src/run/service.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e85-loop-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Call = { name: string; args: Record<string, unknown> };

/** A model that answers each request with its next batch of calls, then finishes. */
function scripted(batches: readonly (readonly Call[])[]) {
	let requests = 0;
	return (async (url: string) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		requests += 1;
		const batch = batches[requests - 1] ?? [{ name: "finish", args: { summary: "done" } }];
		const tool_calls = batch.map((call, index) => ({
			id: `c${requests}-${index}`,
			type: "function",
			function: { name: call.name, arguments: JSON.stringify(call.args) },
		}));
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", tool_calls }, finish_reason: "tool_calls" }] }) };
	}) as unknown as typeof fetch;
}

async function turn(batches: readonly (readonly Call[])[]) {
	const permissions = { sandbox: "workspace-write", approval: "never" };
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl: scripted(batches) },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" },
		capability: compile(policyFromPersona({ permissions }, { personaVersionId: "pv_e85" })),
	});
	const journal = new Journal({});
	const outcome = await new TurnRunner({ provider: defaultLoop(agent), observer: recordTurns({ journal }) }).run({
		turn: "t1",
		prompt: "Build me the page.",
		asker: { kind: "human", id: "david" },
	});
	return { outcome, entries: journal.all() };
}

const verificationEntry = (entries: readonly { body: { type: string } }[]) => entries.find((entry) => entry.body.type === "verification")?.body as
	| { type: "verification"; checks: { what: string; how: string; passed: boolean; reason?: string; scope: string }[]; unverified: string[] }
	| undefined;

const RUNS = "<html><body><script>let n = 0; function tick(){ n += 1; } tick();</script></body></html>";
const CRASHES = "<html><body><script>let f = 0; setInterval(() => { f += 1; if (f > 2) missing(); }, 16);</script></body></html>";

describe("what a turn left is checked before it says it is done (E85)", () => {
	it("runs a page the persona wrote, with no verification declared anywhere", async () => {
		const { outcome, entries } = await turn([[{ name: "write_file", args: { path: "game.html", content: RUNS } }]]);

		expect(outcome.delivered?.checks).toHaveLength(1);
		expect(outcome.delivered?.checks[0]).toMatchObject({ passed: true, scope: "targeted" });
		expect(outcome.delivered?.checks[0]?.what).toContain("game.html");
		expect(verificationEntry(entries)?.checks[0]?.how).toContain("ran it");
	});

	it("catches the page that dies once the clock has moved, which reading it never would", async () => {
		const { outcome, entries } = await turn([[{ name: "write_file", args: { path: "game.html", content: CRASHES } }]]);

		const check = outcome.delivered?.checks[0];
		expect(check?.passed).toBe(false);
		expect(check?.reason).toBeTruthy();
		expect(verificationEntry(entries)?.checks[0]?.passed).toBe(false);
	});

	it("names what it cannot check, because an absence nobody names reads as verified", async () => {
		const { outcome, entries } = await turn([[{ name: "write_file", args: { path: "GAME.md", content: "# A document" } }]]);

		expect(outcome.delivered?.checks).toEqual([]);
		expect(outcome.delivered?.unverified[0]).toContain("GAME.md");
		expect(verificationEntry(entries)?.unverified[0]).toContain("GAME.md");
	});

	it("checks the file as it stands at the end, not as it was when it was first written", async () => {
		// Written broken, then fixed in the same turn: the check is about the version that survives.
		const { outcome } = await turn([
			[{ name: "write_file", args: { path: "game.html", content: CRASHES } }],
			[{ name: "write_file", args: { path: "game.html", content: RUNS } }],
		]);

		expect(outcome.delivered?.checks).toHaveLength(1);
		expect(outcome.delivered?.checks[0]?.passed).toBe(true);
		expect(readFileSync(join(dir, "game.html"), "utf8")).toBe(RUNS);
	});

	it("says nothing about a turn that left nothing, which is not the same as leaving something unchecked", async () => {
		const { outcome, entries } = await turn([[{ name: "read_file", args: { path: "game.html" } }]]);

		expect(outcome.delivered).toBeUndefined();
		expect(verificationEntry(entries)).toBeUndefined();
	});
});
