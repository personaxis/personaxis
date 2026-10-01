/**
 * E159: a classifier reads each tool output while the model thinks. The next model call does not wait for it; the
 * next tool decision does; what it finds raises the taint the consent matrix reads; every score goes to the record
 * in the classifier's name, in `act` mode; and a classifier that fails or is absent changes nothing.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compile, DEFAULT_POLICY, PersonaAgent, policyFromPersona } from "../src/index.js";
import { MALICIOUS_AT, SUSPICIOUS_AT, taintOf, type OutputClassifier } from "../src/judge/output-scan.js";
import { Journal } from "../src/record/journal.js";
import { defaultLoop } from "../src/run/default-provider.js";
import { recordTurns } from "../src/run/recording.js";
import { TurnRunner } from "../src/run/service.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-scan-"));
	writeFileSync(join(dir, "notes.txt"), "Some notes about the frog game.");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A classifier that takes `ms` to answer `p`, and writes down when each scan ended. */
function slowClassifier(p: number, ms: number, fail = false) {
	const ended: number[] = [];
	const classifier: OutputClassifier = {
		engine: "fake-wolf@0000000",
		async classify() {
			await sleep(ms);
			ended.push(performance.now());
			if (fail) throw new Error("the model would not load");
			return { p };
		},
	};
	return { classifier, ended };
}

/** Read a file, write one, finish; with the time each model call started. */
async function turn(classifier?: OutputClassifier, asked = false) {
	const script = [
		{ name: "read_file", args: { path: "notes.txt" } },
		{ name: "write_file", args: { path: "out.txt", content: "x" } },
		{ name: "finish", args: { summary: "Done." } },
	];
	const modelCalls: number[] = [];
	let at = 0;
	const fetchImpl = (async (url: string) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		modelCalls.push(performance.now());
		const next = script[Math.min(at++, script.length - 1)]!;
		const tool_calls = [{ id: `c${at}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }];
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", tool_calls }, finish_reason: "tool_calls" }] }) };
	}) as unknown as typeof fetch;
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: asked ? "on-request" : "never" },
		capability: compile(policyFromPersona({ permissions: { sandbox: "workspace-write", approval: asked ? "on-request" : "never" } }, { personaVersionId: "pv_scan" })),
		...(classifier ? { outputClassifier: async () => classifier } : {}),
		// A person who says yes to everything, so a call that is asked about runs and its output is read.
		...(asked ? { onApproval: async () => "approve" as const } : {}),
	});
	const decided: number[] = [];
	agent.bus.on((event) => {
		if (event.type === "tool-verdict") decided.push(performance.now());
	});
	const journal = new Journal({});
	const outcome = await new TurnRunner({ provider: defaultLoop(agent), observer: recordTurns({ journal }) }).run({
		turn: "t1",
		prompt: "Read my notes and write a file.",
		asker: { kind: "human", id: "david" },
	});
	return { outcome, entries: journal.all(), modelCalls, decided };
}

describe("what a score means (E159)", () => {
	it("is clean up to the measured threshold, suspicious above it, malicious from one half", () => {
		expect(taintOf(SUSPICIOUS_AT)).toBe("clean");
		expect(taintOf(SUSPICIOUS_AT * 1.01)).toBe("suspicious");
		expect(taintOf(MALICIOUS_AT)).toBe("malicious");
	});
});

describe("a classifier on tool outputs, through a real turn (E159)", () => {
	it("lets the next model call start before it answers, and makes the next tool decision wait for it", async () => {
		const { classifier, ended } = slowClassifier(0, 150);
		const { modelCalls, decided } = await turn(classifier);
		// The read's output is scanned; the model call after the read starts before that scan ends.
		expect(modelCalls[1]).toBeLessThan(ended[0]!);
		// The write is decided only after the scan of the read ended.
		expect(decided[1]).toBeGreaterThan(ended[0]!);
	});

	it("writes every score in the classifier's name, in act mode, and a clean score changes nothing", async () => {
		const { classifier } = slowClassifier(0, 5);
		const watched = await turn(classifier);
		const plain = await turn();
		const judgements = watched.entries.filter((entry) => entry.body.type === "judgement");
		// The read and the write both produced output that was scanned.
		expect(judgements.length).toBe(2);
		for (const entry of judgements) {
			expect(entry.author).toEqual({ kind: "component", name: "pax" });
			expect(entry.body).toMatchObject({ site: "tool-output", question: "injection", engine: "fake-wolf@0000000", answer: { kind: "noul", p: 0 }, mode: "act" });
		}
		expect(watched.outcome.stopReason).toBe(plain.outcome.stopReason);
		expect(watched.outcome.calls?.map((call) => call.verdict)).toEqual(plain.outcome.calls?.map((call) => call.verdict));
	});

	it("reads the output of a call that ran after a person approved it, too", async () => {
		const { classifier } = slowClassifier(0, 5);
		const { outcome, entries } = await turn(classifier, true);
		expect(outcome.calls?.find((call) => call.tool === "write_file")?.reason).toBe("approved when asked");
		expect(entries.filter((entry) => entry.body.type === "judgement").length).toBe(2);
	});

	it("raises the taint on a high score, so the write after a poisoned read is not allowed without asking", async () => {
		const { classifier } = slowClassifier(0.9, 5);
		const { outcome } = await turn(classifier);
		const plain = await turn();
		// Without the classifier the write is allowed outright; with it the taint makes the consent matrix ask, and in
		// a run with nobody to ask that is a refusal.
		expect(plain.outcome.calls?.find((call) => call.tool === "write_file")?.verdict).toBe("allowed");
		const write = outcome.calls?.find((call) => call.tool === "write_file");
		expect(write?.verdict).toBe("denied");
		expect(write?.reason).toMatch(/nobody to ask/);
	});

	it("with a classifier that fails, writes no judgement and the turn runs as it would have", async () => {
		const { classifier } = slowClassifier(0.9, 5, true);
		const failed = await turn(classifier);
		const plain = await turn();
		expect(failed.entries.some((entry) => entry.body.type === "judgement")).toBe(false);
		expect(failed.outcome.calls?.map((call) => call.verdict)).toEqual(plain.outcome.calls?.map((call) => call.verdict));
	});
});
