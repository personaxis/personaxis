/**
 * `ask_person`: ask for what only a person can give, with options, and never invent the answer.
 *
 * ## Why this exists
 *
 * E84. A persona missing something it could not find out for itself had two moves: invent it, or stop
 * and say so in prose that a surface cannot tell apart from an answer. Neither is a question. This one
 * is: the question, two to four options and the one the persona recommends, so whoever answers can
 * choose in a second, and a program reading the result can see exactly what was asked.
 *
 * ## Who answers
 *
 * The loop handles the call, because only the run knows whether anybody is there. With somebody in front
 * of it (the TUI), the answer comes back as this call's result. With nobody (a service step, a delegated
 * sub-task, the daemon, a headless run), David decided on 2026-09-15 (P10 of E77) that the step stops and
 * leaves the question written for whoever picks it up: the turn ends at the question, the question is its
 * written result, and nothing is guessed in its place.
 */

import { READ_CLASS } from "./gates.js";
import type { ToolSpec } from "./registry.js";

/** The name the loop special-cases. One owner, so a rename cannot half-happen. */
export const ASK_PERSON_TOOL = "ask_person";

export interface QuestionOption {
	readonly label: string;
	readonly detail?: string;
}

/** A question as asked: what, the options, and the one the persona recommends when it named one of them. */
export interface PersonQuestion {
	readonly question: string;
	readonly options: readonly QuestionOption[];
	readonly recommended?: string;
}

/**
 * The declaration the model is shown. Its `execute` is never reached: the loop intercepts by name, and the
 * body says so rather than returning something plausible.
 */
export const askPersonTool: ToolSpec = {
	name: ASK_PERSON_TOOL,
	category: "meta",
	description:
		"Ask the person for something only they can give: a choice that is theirs, or information you cannot find yourself. " +
		"Give two to four options and say which one you recommend. Never invent the answer; if nobody can answer now, the turn stops here with your question written down.",
	parameters: {
		type: "object",
		additionalProperties: false,
		required: ["question", "options"],
		properties: {
			question: { type: "string", description: "The question, in one or two sentences." },
			options: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["label"],
					properties: {
						label: { type: "string", description: "The option, in a few words." },
						detail: { type: "string", description: "What choosing it means." },
					},
				},
			},
			recommended: { type: "string", description: "The label of the option you recommend." },
		},
	},
	isReadOnly: true,
	isConcurrencySafe: false,
	envelope: [],
	gate: () => ({ decision: "allow", reason: "a question to the person, which grants nothing", class: READ_CLASS }),
	execute: async () => "error: ask_person is handled by the loop, and this body should never run.",
};

export type QuestionRead = { readonly ok: true; readonly question: PersonQuestion } | { readonly ok: false; readonly reply: string };

/** The question out of a call's arguments, or what to tell the model when it cannot be asked as written. */
export function readQuestion(args: Record<string, unknown>): QuestionRead {
	const question = typeof args.question === "string" ? args.question.replace(/\s+/g, " ").trim() : "";
	if (!question) return { ok: false, reply: "error: say the question in `question`." };

	const options: QuestionOption[] = [];
	for (const entry of Array.isArray(args.options) ? args.options : []) {
		const item = (entry ?? {}) as { label?: unknown; detail?: unknown };
		const label = typeof item.label === "string" ? item.label.replace(/\s+/g, " ").trim() : "";
		if (!label || options.some((option) => option.label === label)) continue;
		const detail = typeof item.detail === "string" ? item.detail.replace(/\s+/g, " ").trim() : "";
		options.push(detail ? { label, detail } : { label });
	}
	if (options.length < 2) {
		return { ok: false, reply: "error: give at least two options in `options`, each with a `label`, so whoever answers can choose." };
	}

	// Four at most: past that it stops being a choice somebody makes in a second.
	const kept = options.slice(0, 4);
	const recommended = typeof args.recommended === "string" ? args.recommended.trim() : "";
	return { ok: true, question: { question, options: kept, ...(kept.some((option) => option.label === recommended) ? { recommended } : {}) } };
}

/** The question as text, the same for a person, a parent persona and a program reading a result. */
export function renderQuestion(question: PersonQuestion): string {
	const lines = [question.question];
	question.options.forEach((option, index) => {
		const mark = option.label === question.recommended ? " (recommended)" : "";
		lines.push(`  ${index + 1}. ${option.label}${mark}${option.detail ? `: ${option.detail}` : ""}`);
	});
	return lines.join("\n");
}

/**
 * What a person typed, read against the options. A number or a label picks that option; anything else is
 * their own words and is kept as they wrote them. Nothing typed is no answer: a recommendation is the
 * persona's opinion, and taking it for the person's would be the invented answer this tool exists to prevent.
 */
export function answerFrom(question: PersonQuestion, typed: string): string {
	const text = typed.replace(/\s+/g, " ").trim();
	if (/^\d+$/.test(text)) {
		const picked = question.options[Number(text) - 1];
		if (picked) return picked.label;
	}
	const byLabel = question.options.find((option) => option.label.toLowerCase() === text.toLowerCase());
	return byLabel ? byLabel.label : text;
}
