/**
 * The interview: questions a model writes for this job, asked only where the sources leave a gap.
 *
 * Until 2026-10-07 the interview was a fixed bank of twelve (or twenty) questions mapped to numbers by fixed
 * rules ("a 4 of 5 becomes a mean of 0.70"). Now a model reads the sources and the answers so far, says which
 * parts of the persona they already cover, and writes the next few questions about what is missing, up to
 * `INTERVIEW_LIMIT` in all. It is told what the research says about eliciting: models recover less than half
 * of the implicit requirements of a job when they interview (ReqElicitGym, 2025), and tacit knowledge comes
 * out of cases, not rules, so it asks about real work ("the last change you rejected, and why") rather than
 * for adjectives or ratings. Every question can be skipped, and what is skipped is inferred and reported.
 *
 * The answers are one source the authoring model reads and cites (`interviewAsSource`), so nothing in the
 * persona comes from a rule about an answer. The code checks each round (a known part of the persona, no
 * question asked twice, no more than the round allows) and asks again with the exact problems, as authoring
 * does.
 */

import { createHash } from "node:crypto";

import { ModelRequiredError } from "../model-config.js";
import { renderSources, type Source } from "./sources.js";
import { STAGES } from "./stages.js";
import type { StructuredCaller } from "./types.js";

/** The most questions one creation asks, across every round. */
export const INTERVIEW_LIMIT = 15;
/** The most questions one round asks, so the next round can follow up on the answers. */
const ROUND = 5;
const REPAIRS = 2;

export interface InterviewQuestion {
	/** `q1`, `q2`, ... in the order asked. */
	id: string;
	/** The stage of `STAGES` the answer informs. */
	stage: string;
	question: string;
	/** What the sources leave open, in one line the person reads before answering. */
	why: string;
	/** Typical answers to pick from; the person may always write their own. */
	options?: string[];
}

export interface InterviewTurn {
	question: InterviewQuestion;
	/** What the person said; absent when they skipped it. */
	answer?: string;
}

export interface InterviewRound {
	reasoning: string;
	/** How much the sources and answers already say about each stage. */
	coverage: Array<{ stage: string; status: "stated" | "partial" | "missing" }>;
	/** The next questions; empty when what is left can be inferred. */
	questions: InterviewQuestion[];
}

class InterviewError extends Error {
	constructor(public readonly issues: string[]) {
		super(`The interview could not continue: ${issues.slice(0, 4).join("; ")}${issues.length > 4 ? ` (+${issues.length - 4} more)` : ""}`);
		this.name = "InterviewError";
	}
}

const STAGE_IDS = STAGES.map((s) => s.id);

const INTERVIEW_SCHEMA = {
	type: "object",
	required: ["reasoning", "coverage", "questions"],
	properties: {
		reasoning: { type: "string", description: "What the sources and answers already say, what is missing, and which gaps only the person can fill." },
		coverage: {
			type: "array",
			items: {
				type: "object",
				required: ["stage", "status"],
				properties: { stage: { type: "string", enum: STAGE_IDS }, status: { type: "string", enum: ["stated", "partial", "missing"] } },
			},
		},
		questions: {
			type: "array",
			items: {
				type: "object",
				required: ["stage", "question", "why"],
				properties: {
					stage: { type: "string", enum: STAGE_IDS },
					question: { type: "string" },
					why: { type: "string" },
					options: { type: "array", items: { type: "string" } },
				},
			},
		},
	},
} as const;

const said = (turns: readonly InterviewTurn[]): string =>
	turns.length
		? turns.map((t) => `${t.question.id} [${t.question.stage}] ${t.question.question}\n   ${t.answer === undefined ? "(skipped: do not ask it again; it will be inferred)" : `answer: ${t.answer}`}`).join("\n")
		: "(none yet)";

/** The prompt for the next round. Deterministic for the same inputs, which the `agent` provider relies on. */
function interviewPrompt(sources: readonly Source[], turns: readonly InterviewTurn[]): string {
	const room = Math.min(ROUND, INTERVIEW_LIMIT - turns.length);
	return [
		"You are interviewing the person who is creating an AI persona: the complete way a professional does a job",
		"(procedures, criteria, tools, knowledge with sources, character and limits). A model will write the persona",
		"from the SOURCES and from this interview's answers, one part at a time. Your job is to ask the person only",
		"what the sources leave open and what they can answer better than a model could infer.",
		"",
		"The parts of a persona:",
		...STAGES.map((s) => `- ${s.id}: ${s.title}`),
		"",
		"What to ask about, in this order, skipping whatever the sources already say:",
		"1. How the work is done: the steps, what it checks first, what good output looks like (the criteria).",
		"2. What must never happen, and why: the limits that come from experience, the mistakes that cost the most.",
		"3. A real case: one piece of work that went wrong or was rejected, and what decided it.",
		"4. How it sounds: offer a short example line the person can correct, rather than asking for adjectives.",
		"5. Who it answers to, and when it stops and asks a person.",
		"The other parts (affect, memory, metacognition, governance) are inferred from these answers. Do not walk",
		"through the parts as a checklist; ask about one of them only when this job makes it matter.",
		"Once the person has answered, follow up on what they said before opening anything new: the edge of a rule",
		"they gave (where does it stop applying?), a case that would break it, the reason behind a",
		"choice. Never ask what motivates them or what an answer says about the persona's character.",
		"",
		"How to ask:",
		"- About real work, not adjectives or abstractions. Models interviewing recover less than half of a job's",
		"  implicit requirements, and tacit knowledge comes out of cases, not rules. The shape, from other trades (write",
		"  your own for this job, never these):",
		"  weak: 'What principles guide your editing?'         better: 'What was the last draft you sent back, and why?'",
		"  weak: 'How does the nurse stay calm?'               better: 'A patient refuses the medication. What do you say next?'",
		"  weak: 'How does the analyst improve over time?'     better: 'When a forecast of yours missed, what did you change?'",
		"- Do not assume a tone the sources do not state (harsh, friendly, gentle); ask with an example instead.",
		"- Never ask the person to rate traits on a scale, and never ask about the format of the persona (ranges,",
		"  bands, half-lives, governance modes): those are inferred from what they say about the work.",
		"- One thing per question, in plain words, short. Ask in the language the sources are written in.",
		"- Give `options` only when a few typical answers exist; the person can always write their own.",
		"- Do not ask what the sources already state, and do not ask again anything already asked, answered or skipped.",
		"  A skipped question closes its part: ask nothing more about that part.",
		`- Ask at most ${room} question(s) now, and none once the five things above are answered or skipped, unless`,
		"  an answer is vague or contradicts another. Fifteen is a ceiling, not a target: every question costs the",
		"  person time, and what is left is inferred and reported for them to check.",
		"",
		"Write `reasoning` first: what the sources and answers say, what is missing, and which gaps only the person can",
		"fill. Then `coverage`, one entry per part. Then `questions`, each with the part it informs and `why`: one line",
		"the person reads before answering, saying what is missing.",
		"",
		"SOURCES:",
		sources.length ? renderSources(sources) : "(none: the person has given nothing yet; start from what the persona is for)",
		"",
		"ASKED SO FAR:",
		said(turns),
	].join("\n");
}

const normal = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Every problem with one round's answer; empty when it can be asked. */
function checkRound(answer: unknown, turns: readonly InterviewTurn[]): string[] {
	const issues: string[] = [];
	const a = answer as Partial<InterviewRound> | null;
	if (!a || typeof a !== "object") return ["The answer is not a JSON object with `reasoning`, `coverage` and `questions`."];
	if (typeof a.reasoning !== "string" || !a.reasoning.trim()) issues.push("`reasoning` is missing or empty.");
	if (!Array.isArray(a.coverage)) issues.push("`coverage` must be a list with one entry per part.");
	if (!Array.isArray(a.questions)) return [...issues, "`questions` must be a list (empty when nothing is left to ask)."];
	const room = Math.min(ROUND, INTERVIEW_LIMIT - turns.length);
	if (a.questions.length > room) issues.push(`Ask at most ${room} question(s) now; you asked ${a.questions.length}.`);
	const seen = new Set(turns.map((t) => normal(t.question.question)));
	// A skipped question closes its part (measured 2026-10-07: command-a re-asked a skipped escalation
	// question in other words the next round, which no comparison of the text can catch).
	const closed = new Set(turns.filter((t) => t.answer === undefined).map((t) => t.question.stage));
	a.questions.forEach((q, i) => {
		const n = `questions[${i}]`;
		if (!q || typeof q !== "object") return void issues.push(`${n} is not an object.`);
		if (!STAGE_IDS.includes(q.stage)) issues.push(`${n}.stage must be one of: ${STAGE_IDS.join(", ")}.`);
		else if (closed.has(q.stage)) issues.push(`${n} asks about ${q.stage}, whose question the person skipped; ask nothing more about that part.`);
		if (typeof q.question !== "string" || !q.question.trim()) issues.push(`${n}.question is empty.`);
		else if (seen.has(normal(q.question))) issues.push(`${n} was already asked: "${q.question}". Ask something else or nothing.`);
		else seen.add(normal(q.question));
		if (typeof q.why !== "string" || !q.why.trim()) issues.push(`${n}.why is empty: say in one line what the sources leave open.`);
		if (q.options !== undefined && (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6 || q.options.some((o) => typeof o !== "string" || !o.trim())))
			issues.push(`${n}.options, when given, are 2 to 6 non-empty answers.`);
	});
	return issues;
}

/**
 * The next round of questions, numbered after the ones already asked. Empty when the model has nothing left
 * worth asking or the limit is reached. Throws `ModelRequiredError` without a model and `InterviewError` when
 * a round still fails its checks after `REPAIRS` repairs.
 */
async function nextQuestions(sources: readonly Source[], turns: readonly InterviewTurn[], call: StructuredCaller | null): Promise<InterviewRound> {
	if (!call) throw new ModelRequiredError("The interview");
	if (turns.length >= INTERVIEW_LIMIT) return { reasoning: "", coverage: [], questions: [] };
	const prompt = interviewPrompt(sources, turns);
	let answer = await call(prompt, INTERVIEW_SCHEMA, "interview_round");
	let issues = checkRound(answer, turns);
	for (let attempt = 1; issues.length; attempt += 1) {
		if (attempt > REPAIRS) throw new InterviewError(issues);
		answer = await call(`${prompt}\n\nYour previous answer was:\n${JSON.stringify(answer)}\n\nIt failed these checks. Answer again with all of them fixed:\n- ${issues.join("\n- ")}`, INTERVIEW_SCHEMA, "interview_round");
		issues = checkRound(answer, turns);
	}
	const round = answer as InterviewRound;
	return {
		reasoning: round.reasoning,
		coverage: round.coverage,
		questions: round.questions.map((q, i) => ({
			id: `q${turns.length + i + 1}`,
			stage: q.stage,
			question: q.question.trim(),
			why: q.why.trim(),
			...(q.options ? { options: q.options.map((o) => o.trim()) } : {}),
		})),
	};
}

/** What the person did with one question: an answer, a skip, or leaving the interview. */
export type Reply = { answer: string } | { skip: true } | { stop: true };

/**
 * Run the interview to its end: rounds of questions until the model asks none, the limit is reached or the
 * person leaves. `ask` puts one round in front of the person (a terminal, a wizard, a test) and returns one
 * reply per question it got to; `onTurn` sees every turn as it is recorded, so an abandoned interview keeps
 * what was answered.
 */
export async function runInterview(input: {
	sources: readonly Source[];
	call: StructuredCaller | null;
	ask: (questions: InterviewQuestion[], asked: number) => Promise<Reply[]>;
	turns?: readonly InterviewTurn[];
	onTurn?: (turns: readonly InterviewTurn[]) => void;
	onRound?: (round: InterviewRound) => void;
}): Promise<InterviewTurn[]> {
	const turns: InterviewTurn[] = [...(input.turns ?? [])];
	for (;;) {
		const round = await nextQuestions(input.sources, turns, input.call);
		input.onRound?.(round);
		if (!round.questions.length) return turns;
		const replies = await input.ask(round.questions, turns.length);
		for (const [i, question] of round.questions.entries()) {
			const reply = replies[i];
			if (!reply || "stop" in reply) return turns;
			turns.push("answer" in reply && reply.answer.trim() ? { question, answer: reply.answer.trim() } : { question });
			input.onTurn?.(turns);
		}
	}
}

/** The answered questions as one source: each question and what the person said. */
export function interviewAsSource(turns: readonly InterviewTurn[]): Omit<Source, "id"> | undefined {
	const answered = turns.filter((t) => t.answer !== undefined);
	return answered.length
		? { kind: "answer", label: "interview answers", text: answered.map((t) => `Q: ${t.question.question}\nA: ${t.answer}`).join("\n\n") }
		: undefined;
}

/** A fingerprint of the sources, so a saved interview is resumed only over the same material. */
export function sourcesFingerprint(sources: ReadonlyArray<Omit<Source, "id">>): string {
	return createHash("sha256")
		.update(JSON.stringify(sources.map((s) => [s.kind, s.label, s.text])))
		.digest("hex")
		.slice(0, 16);
}
