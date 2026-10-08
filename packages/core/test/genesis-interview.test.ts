/**
 * The adaptive interview: a model writes the questions for what the sources leave open, the code checks each
 * round, and the answers become one source. The model is a stub; what is pinned is what the code does with
 * it, through `runInterview`, the one door the CLI uses (the checks are read where the model reads them: in
 * the repair prompt).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	INTERVIEW_LIMIT,
	ModelRequiredError,
	clearDraft,
	interviewAsSource,
	loadDraft,
	numberSources,
	runInterview,
	saveDraft,
	sourcesFingerprint,
	type InterviewQuestion,
	type InterviewTurn,
	type StructuredCaller,
} from "../src/index.js";

const sources = numberSources([{ kind: "brief", label: "the brief", text: "A code reviewer for a payments team." }]);
const q = (stage: string, question: string, extra: Record<string, unknown> = {}) => ({ stage, question, why: "the sources do not say", ...extra });
const round = (questions: unknown[]) => ({ reasoning: "The brief names the job and nothing about limits.", coverage: [{ stage: "identity", status: "stated" }], questions });
const turn = (id: string, question: string, answer?: string): InterviewTurn => ({ question: { id, stage: "self_regulation", question, why: "w" }, ...(answer === undefined ? {} : { answer }) });
const leave = async (): Promise<Array<{ stop: true }>> => [{ stop: true }];

/** What the code said was wrong with `answer`, as the model reads it in the repair prompt; "" when nothing. */
async function issuesOf(answer: unknown, turns: InterviewTurn[] = []): Promise<string> {
	const prompts: string[] = [];
	const call: StructuredCaller = async (prompt) => (prompts.push(prompt), prompts.length === 1 ? answer : round([]));
	await runInterview({ sources, call, turns, ask: leave });
	return prompts[1]?.split("It failed these checks")[1] ?? "";
}

describe("what the code refuses in a round", () => {
	it("accepts a round of questions about known parts, and an empty round", async () => {
		expect(await issuesOf(round([q("self_regulation", "What change must it never approve?"), q("persona", "How should it word a rejection?", { options: ["blunt", "explained"] })]))).toBe("");
		expect(await issuesOf(round([]))).toBe("");
	});

	it("refuses an unknown part, an empty why, and options that are not choices", async () => {
		const issues = await issuesOf(round([q("vibes", "Is it fun?"), { stage: "persona", question: "Tone?", why: " " }, q("persona", "Formal?", { options: ["yes"] })]));
		expect(issues).toMatch(/questions\[0\]\.stage must be one of/);
		expect(issues).toMatch(/questions\[1\]\.why is empty/);
		expect(issues).toMatch(/questions\[2\]\.options, when given, are 2 to 6/);
	});

	it("refuses a question already asked, however it is punctuated", async () => {
		expect(await issuesOf(round([q("cognition", "what does it check FIRST")]), [{ question: { id: "q1", stage: "cognition", question: "What does it check first?", why: "w" }, answer: "tests" }])).toMatch(/was already asked/);
	});

	it("refuses a new question about a part whose question was skipped, in any words", async () => {
		expect(await issuesOf(round([q("self_regulation", "When does it stop and ask a person?")]), [turn("q1", "What must it never approve?")])).toMatch(/asks about self_regulation, whose question the person skipped/);
		expect(await issuesOf(round([q("self_regulation", "When does it stop?")]), [turn("q1", "What must it never approve?", "Logging secrets.")])).toBe("");
	});

	it("caps a round at five, and the whole interview at the limit", async () => {
		const six = Array.from({ length: 6 }, (_, i) => q("cognition", `Question number ${i}?`));
		expect(await issuesOf(round(six))).toMatch(/Ask at most 5 question\(s\) now; you asked 6/);
		const asked = Array.from({ length: INTERVIEW_LIMIT - 2 }, (_, i) => turn(`q${i + 1}`, `Earlier ${i}?`, "x"));
		expect(await issuesOf(round(six.slice(0, 3)), asked)).toMatch(/Ask at most 2 question\(s\) now/);
	});

	it("asks again with the exact problems, twice, then stops visibly", async () => {
		const prompts: string[] = [];
		const call: StructuredCaller = async (prompt) => (prompts.push(prompt), round([q("vibes", "Is it fun?")]));
		await expect(runInterview({ sources, call, ask: leave })).rejects.toThrow(/The interview could not continue: questions\[0\]\.stage/);
		expect(prompts).toHaveLength(3);
	});
});

describe("the prompt", () => {
	it("is the same for the same inputs, so an agent's recorded answers replay", async () => {
		const seen: string[] = [];
		const call: StructuredCaller = async (prompt) => (seen.push(prompt), round([]));
		const turns = [turn("q1", "What must it never approve?", "Logging secrets.")];
		await runInterview({ sources, call, turns, ask: leave });
		await runInterview({ sources, call, turns, ask: leave });
		expect(seen[0]).toBe(seen[1]);
	});

	it("carries the sources, every part of the persona, and what was answered or skipped", async () => {
		let p = "";
		const call: StructuredCaller = async (prompt) => ((p = prompt), round([]));
		await runInterview({ sources, call, turns: [turn("q1", "What must it never approve?", "Logging secrets."), turn("q2", "How should it sound?")], ask: leave });
		expect(p).toContain('<source id="S1" kind="brief"');
		expect(p).toContain("- self_regulation:");
		expect(p).toContain("answer: Logging secrets.");
		expect(p).toContain("(skipped: do not ask it again");
		expect(p).toContain("Never ask the person to rate traits on a scale");
	});
});

describe("runInterview", () => {
	it("refuses without a model", async () => {
		await expect(runInterview({ sources, call: null, ask: leave })).rejects.toBeInstanceOf(ModelRequiredError);
	});

	it("follows up on the answers, numbers the questions, records skips, and ends when the model asks nothing", async () => {
		const seen: string[] = [];
		const rounds = [round([q("cognition", "What does it check first?"), q("persona", "How should it sound?")]), round([q("cognition", "Why the tests first?")]), round([])];
		const call: StructuredCaller = async (prompt) => (seen.push(prompt), rounds.shift());
		const saved: number[] = [];
		const asked: string[][] = [];
		const turns = await runInterview({
			sources,
			call,
			ask: async (questions: InterviewQuestion[]) => (asked.push(questions.map((x) => x.id)), questions.map((x) => (x.stage === "persona" ? { skip: true as const } : { answer: `about ${x.id}` }))),
			onTurn: (t) => saved.push(t.length),
		});
		expect(asked).toEqual([["q1", "q2"], ["q3"]]);
		expect(turns.map((t) => [t.question.id, t.answer])).toEqual([["q1", "about q1"], ["q2", undefined], ["q3", "about q3"]]);
		expect(saved).toEqual([1, 2, 3]);
		// The second round was written knowing the first round's answers.
		expect(seen[1]).toContain("answer: about q1");
	});

	it("stops where the person leaves, keeping what was answered", async () => {
		const call: StructuredCaller = async () => round([q("persona", "One?"), q("persona", "Two?")]);
		const turns = await runInterview({ sources, call, ask: async () => [{ answer: "first" }, { stop: true }] });
		expect(turns).toHaveLength(1);
	});

	it("resumes from saved turns without asking them again, and asks the model nothing at the limit", async () => {
		let prompt = "";
		const call: StructuredCaller = async (p) => ((prompt = p), round([]));
		expect(await runInterview({ sources, call, ask: leave, turns: [turn("q1", "Saved question?", "saved answer")] })).toHaveLength(1);
		expect(prompt).toContain("answer: saved answer");

		let calls = 0;
		const full = Array.from({ length: INTERVIEW_LIMIT }, (_, i) => turn(`q${i + 1}`, `Q ${i}?`, "a"));
		await runInterview({ sources, call: async () => (calls++, round([])), ask: leave, turns: full });
		expect(calls).toBe(0);
	});
});

describe("interviewAsSource", () => {
	it("keeps the answered questions as one source and leaves the skipped ones out", () => {
		const s = interviewAsSource([turn("q1", "What must it never approve?", "Logging secrets."), turn("q2", "How should it sound?")]);
		expect(s).toEqual({ kind: "answer", label: "interview answers", text: "Q: What must it never approve?\nA: Logging secrets." });
		expect(interviewAsSource([turn("q1", "Only skipped?")])).toBeUndefined();
	});
});

describe("interview drafts", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pxs-draft-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	const print = sourcesFingerprint(sources);
	const file = (): string => join(dir, ".personaxis", "interview-draft.json");

	it("round-trips the turns over the same sources", () => {
		saveDraft(dir, print, [turn("q1", "Q?", "A")]);
		expect(loadDraft(dir, print)?.turns).toEqual([turn("q1", "Q?", "A")]);
		clearDraft(dir);
		expect(loadDraft(dir, print)).toBeUndefined();
	});

	it("is not offered over other sources: those questions were written for another brief", () => {
		saveDraft(dir, print, [turn("q1", "Q?", "A")]);
		const other = sourcesFingerprint(numberSources([{ kind: "brief", label: "the brief", text: "A tavern keeper." }]));
		expect(other).not.toBe(print);
		expect(loadDraft(dir, other)).toBeUndefined();
	});

	it("ignores a torn draft or one from the fixed question bank", () => {
		mkdirSync(join(dir, ".personaxis"), { recursive: true });
		writeFileSync(file(), "{not json");
		expect(loadDraft(dir, print)).toBeUndefined();
		writeFileSync(file(), JSON.stringify({ answers: { "id-name": "Kaya" }, depth: "core", bankVersion: "1.1.0" }));
		expect(loadDraft(dir, print)).toBeUndefined();
	});
});
