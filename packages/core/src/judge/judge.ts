/**
 * E157: a judge, asked at fixed places in the work, whose answers are written down before anyone lets them act.
 *
 * A judge here is a small encoder (Pax, which starts from Laya) that answers typed questions about a piece of text
 * in one forward pass: a probability of yes, or one option out of a few. It does not write text and it does not
 * decide anything on its own. In `shadow` mode, the only mode this file offers, it is asked, its answer goes into
 * the record, and nothing the persona does changes.
 *
 * ## Why shadow first
 *
 * Measured on 2026-09-30 before a line of this was written: untuned, the judge is worse than chance at spotting an
 * instruction hidden in a tool output (AUC 0.285) and worse than the persona's own model at choosing a route (6 of
 * 13 against 18 of 21), while it does carry real signal about whether a request belongs to a persona's role (AUC
 * 0.902). Letting it act everywhere would make the work worse where it is weak. Recording it everywhere costs
 * nothing the persona can feel, and the record is then the evidence for each place it should, or should not, act.
 *
 * ## Why nothing here is loaded unless asked for
 *
 * The judge runs on ONNX Runtime and a model of about 1.7 GB. Neither belongs in the engine's dependencies, so the
 * model and its runtime are loaded from Pax's own repository, named by `PERSONAXIS_PAX_DIR`. Without that variable
 * there is no judge, no entry is written, and every turn runs exactly as before.
 *
 * ## What a judge never sees
 *
 * The request and the persona's own statement of its job. Not tool outputs, for the reason the production
 * classifier of Claude Code strips them: content that arrived from outside must not be able to talk to the judge.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** A question with a typed answer: a probability of yes, or a choice among named options. */
export type JudgeQuestion =
	| { readonly type: "noul"; readonly instructions: string }
	| { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> };

/** What a judge answered to one question. */
export type JudgeAnswer = { readonly kind: "noul"; readonly p: number } | { readonly kind: "choice"; readonly choice: string; readonly p: number };

/** A model that answers typed questions about a state, all of them in one pass. */
export interface Judge {
	/** Model and revision, written into every judgement so two models are never read as one series. */
	readonly engine: string;
	ask(state: Readonly<Record<string, string>>, questions: Readonly<Record<string, JudgeQuestion>>): Promise<Record<string, JudgeAnswer>>;
}

/** One answer, with where it was asked and how long it took, ready for the record. */
export interface Judgement {
	readonly site: string;
	readonly question: string;
	readonly engine: string;
	readonly answer: JudgeAnswer;
	readonly ms: number;
	/** `act` only where a row measured that the judge may change what happens (E159, tool outputs). */
	readonly mode: "shadow" | "act";
}

/**
 * The part of a compiled persona document that says what its job is: its name line and the two lines that say what
 * it works on and what it does not. A compiled document that has neither line yields only the opening, and an empty
 * document yields nothing, in which case the role questions are not asked: judging a role nobody stated would be a
 * guess written into the record.
 */
export function scopeOf(identity: string): string {
	const lines = identity.split(/\r?\n/).map((line) => line.trim());
	// The terminal puts its own "You are X. Stay in character." above the document, so the document's opening is the
	// first "You are" line after its "# You are" heading; without that heading, the first "You are" line there is.
	const heading = lines.findIndex((line) => /^# You are\b/.test(line));
	const opening =
		(heading >= 0 ? lines.slice(heading + 1).find((line) => /^You are\b/.test(line)) : undefined) ??
		lines.find((line) => /^You are\b/.test(line)) ??
		lines[heading]?.replace(/^#\s*/, "");
	const works = lines.find((line) => /^You work on:/.test(line));
	const not = lines.find((line) => /^You do NOT work on:/.test(line));
	return [opening, works, not].filter((line): line is string => Boolean(line)).join(" ");
}

/**
 * The questions asked when a turn opens. `route` uses the bench's own names for what a request asks for, because
 * those are the names whose right answer the bench knows; the persona's decision step names routes differently and
 * is a separate fact in the record.
 */
export const TURN_START_QUESTIONS: Readonly<Record<string, JudgeQuestion>> = {
	in_role: { type: "noul", instructions: "Is the request part of the work this assistant says it does?" },
	route: {
		type: "choice",
		instructions: "What should the assistant do with this request?",
		criteria: {
			answer: "reply with advice or information in the chat",
			ask: "ask a question first, because something needed is missing or unclear",
			document: "write a document",
			build: "build something that runs, such as a program or a game",
			reference: "look up its own reference sources before replying",
			fix: "find and fix a problem in an existing file",
		},
	},
};

/**
 * Asks the turn-start questions and returns them as judgements. Never throws: a judge that fails leaves no
 * judgement and a line on stderr, and the turn it was watching is not affected.
 */
export async function judgeTurnStart(judge: Judge, scope: string, request: string): Promise<readonly Judgement[]> {
	if (!scope.trim() || !request.trim()) return [];
	const started = performance.now();
	try {
		const answers = await judge.ask({ persona: scope, request }, TURN_START_QUESTIONS);
		const ms = Math.round(performance.now() - started);
		return Object.entries(answers).map(([question, answer]) => ({ site: "turn-start", question, engine: judge.engine, answer, ms, mode: "shadow" as const }));
	} catch (error) {
		process.stderr.write(`[judge] ${judge.engine} failed at turn-start: ${error instanceof Error ? error.message : String(error)}\n`);
		return [];
	}
}

/** The shape laya-ts returns per question, as far as this file reads it. */
interface PaxAnswer {
	readonly noul?: number;
	readonly choice?: string;
	readonly probabilities?: Readonly<Record<string, number>>;
}

/**
 * Loads Pax from its repository: the ONNX export under `models/laya-en/onnx` and the TypeScript runtime under
 * `upstream/laya/laya-ts/dist`, both built there and not here. The engine name carries the weights' revision from
 * Pax's `UPSTREAM.md`, so a judgement can always be traced to the exact model that gave it.
 */
export async function loadPax(dir: string): Promise<Judge> {
	const runtime = (await import(pathToFileURL(join(dir, "upstream", "laya", "laya-ts", "dist", "index.js")).href)) as {
		Agent: { load(path: string, opts: { device: string }): Promise<{ predict(state: unknown, questions: unknown): Promise<{ answers: Record<string, PaxAnswer> }> }> };
	};
	const agent = await runtime.Agent.load(join(dir, "models", "laya-en", "onnx"), { device: "cpu" });
	const upstream = readFileSync(join(dir, "UPSTREAM.md"), "utf8");
	const revision = /revision `([0-9a-f]{7})/.exec(upstream)?.[1] ?? "unknown";
	return {
		engine: `pax-en@${revision}`,
		async ask(state, questions) {
			const result = await agent.predict(state, questions);
			const out: Record<string, JudgeAnswer> = {};
			for (const [name, question] of Object.entries(questions)) {
				const got = result.answers[name];
				if (got === undefined) continue;
				if (question.type === "noul" && typeof got.noul === "number") out[name] = { kind: "noul", p: got.noul };
				else if (question.type === "choice" && typeof got.choice === "string") out[name] = { kind: "choice", choice: got.choice, p: got.probabilities?.[got.choice] ?? Number.NaN };
			}
			return out;
		},
	};
}

let fromEnv: Promise<Judge | undefined> | undefined;

/**
 * The judge named by `PERSONAXIS_PAX_DIR`, loaded once per process. Undefined when the variable is not set, and
 * undefined with one line on stderr when it is set and loading fails, so a broken judge never stops a turn.
 */
export function judgeFromEnv(): Promise<Judge | undefined> {
	const dir = process.env.PERSONAXIS_PAX_DIR;
	if (!dir) return Promise.resolve(undefined);
	fromEnv ??= loadPax(dir).catch((error: unknown) => {
		process.stderr.write(`[judge] could not load Pax from ${dir}: ${error instanceof Error ? error.message : String(error)}\n`);
		return undefined;
	});
	return fromEnv;
}
