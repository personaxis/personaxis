/**
 * E157: a judge watches a turn in shadow. Its answers travel with the turn to the record, in the judge's name, before
 * everything else the turn wrote; a judge that fails or is absent changes nothing; the persona's statement of its job
 * is the only thing about the persona it is shown.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compile, DEFAULT_POLICY, PersonaAgent, policyFromPersona } from "../src/index.js";
import { judgeTurnStart, scopeOf, type Judge } from "../src/judge/judge.js";
import { Journal } from "../src/record/journal.js";
import { defaultLoop } from "../src/run/default-provider.js";
import { recordTurns } from "../src/run/recording.js";
import { TurnRunner } from "../src/run/service.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-judge-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DOC = [
	"# You are Gamewright",
	"",
	"You are **Gamewright**, the game designer. Turn a request for a game into a design and a prototype.",
	"You think, speak, and decide as this persona.",
	"",
	"You work on: Game design of any genre, Playable prototypes that run in a browser.",
	"You do NOT work on: Production art, Legal and business advice.",
].join("\n");

/** A judge that answers fixed values and remembers what it was shown. */
function fakeJudge(fail = false) {
	const shown: Record<string, string>[] = [];
	const judge: Judge = {
		engine: "fake@0000000",
		async ask(state, questions) {
			shown.push({ ...state });
			if (fail) throw new Error("the model would not load");
			const out: Record<string, { kind: "noul"; p: number } | { kind: "choice"; choice: string; p: number }> = {};
			for (const [name, q] of Object.entries(questions)) out[name] = q.type === "noul" ? { kind: "noul", p: 0.91 } : { kind: "choice", choice: "build", p: 0.6 };
			return out;
		},
	};
	return { judge, shown };
}

/** One turn through the real runner and recorder, with a model that finishes at once. */
async function turn(judging?: Parameters<typeof defaultLoop>[2]) {
	const fetchImpl = (async (url: string) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		const tool_calls = [{ id: "c1", type: "function", function: { name: "finish", arguments: JSON.stringify({ summary: "Here is the game." }) } }];
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", tool_calls }, finish_reason: "tool_calls" }] }) };
	}) as unknown as typeof fetch;
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" },
		capability: compile(policyFromPersona({ permissions: { sandbox: "workspace-write", approval: "never" } }, { personaVersionId: "pv_judge" })),
	});
	const journal = new Journal({});
	const outcome = await new TurnRunner({ provider: defaultLoop(agent, undefined, judging), observer: recordTurns({ journal }) }).run({
		turn: "t1",
		prompt: "Make me a small game about a frog.",
		asker: { kind: "human", id: "mara" },
	});
	return { outcome, entries: journal.all() };
}

describe("the persona's statement of its job (E157)", () => {
	it("keeps the name line and the two lines that say what it works on and what it does not", () => {
		expect(scopeOf(DOC)).toBe(
			"You are **Gamewright**, the game designer. Turn a request for a game into a design and a prototype. You work on: Game design of any genre, Playable prototypes that run in a browser. You do NOT work on: Production art, Legal and business advice.",
		);
	});

	it("takes the document's own opening, not the line the terminal puts above it", () => {
		expect(scopeOf(`You are Gamewright. Stay in character.\n\n${DOC}`)).toBe(scopeOf(DOC));
	});

	it("is empty for an empty document, and then the role is not judged at all", async () => {
		expect(scopeOf("")).toBe("");
		const { judge, shown } = fakeJudge();
		expect(await judgeTurnStart(judge, scopeOf(""), "Make a game")).toEqual([]);
		expect(shown).toEqual([]);
	});
});

describe("a judge in shadow, through a real turn (E157)", () => {
	it("writes every answer in the judge's name, before the rest of the turn, and changes nothing the persona did", async () => {
		const { judge, shown } = fakeJudge();
		const watched = await turn({ judge: async () => judge, scope: scopeOf(DOC) });
		const plain = await turn();

		// Shown the request and the statement of the job, nothing else.
		expect(shown).toEqual([{ persona: scopeOf(DOC), request: "Make me a small game about a frog." }]);
		expect(watched.outcome.judgements?.map((j) => [j.site, j.question, j.mode])).toEqual([
			["turn-start", "in_role", "shadow"],
			["turn-start", "route", "shadow"],
		]);

		const judgements = watched.entries.filter((entry) => entry.body.type === "judgement");
		// The two turn-start questions, rol and route.
		expect(judgements).toHaveLength(2);
		for (const entry of judgements) expect(entry.author).toEqual({ kind: "component", name: "pax" });
		expect(judgements[0]?.body).toMatchObject({ turn: "t1", site: "turn-start", question: "in_role", engine: "fake@0000000", answer: { kind: "noul", p: 0.91 }, mode: "shadow" });
		expect(judgements[1]?.body).toMatchObject({ question: "route", answer: { kind: "choice", choice: "build", p: 0.6 } });

		// Right after the turn opened, before the answer.
		const types = watched.entries.map((entry) => entry.body.type);
		expect(types.indexOf("judgement")).toBe(types.indexOf("turn-open") + 1);

		// Shadow: the turn itself is the one it would have been without a judge.
		expect(watched.outcome.answer).toBe(plain.outcome.answer);
		expect(watched.outcome.stopReason).toBe(plain.outcome.stopReason);
		expect(watched.entries.filter((entry) => entry.body.type !== "judgement").map((entry) => entry.body.type)).toEqual(plain.entries.map((entry) => entry.body.type));
	});

	it("with no judge configured, writes no judgement and carries no field", async () => {
		const { outcome, entries } = await turn({ judge: async () => undefined, scope: scopeOf(DOC) });
		expect(outcome.judgements).toBeUndefined();
		expect(entries.some((entry) => entry.body.type === "judgement")).toBe(false);
	});

	it("with a judge that fails, writes no judgement and the turn ends as it would have", async () => {
		const { judge } = fakeJudge(true);
		const { outcome, entries } = await turn({ judge: async () => judge, scope: scopeOf(DOC) });
		expect(outcome.stopReason).toBe("answered");
		expect(outcome.judgements).toBeUndefined();
		expect(entries.some((entry) => entry.body.type === "judgement")).toBe(false);
	});
});
