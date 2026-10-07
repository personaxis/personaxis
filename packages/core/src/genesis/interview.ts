/**
 * The interview's answers, as source material.
 *
 * Until 2026-10-07 each answer was mapped to a number by a fixed rule (a 4 on a five-point scale became a
 * trait mean of 0.7). Now the answers are a source the authoring model reads and cites like any other, so a
 * number comes from what the person said and not from the rule. The fixed bank of questions is replaced by
 * questions the model writes for the job in the next step of the redesign (`H15`, step 3).
 */

import { ITEM_BANK, type InterviewItem } from "./item-bank.js";
import type { Source } from "./sources.js";

export type InterviewAnswers = Record<string, string | number | string[]>;

/** Items still worth asking given the answers collected so far. */
export function pendingItems(answers: InterviewAnswers, depth: "core" | "deep" = "deep"): InterviewItem[] {
	return ITEM_BANK.filter((item) => answers[item.id] === undefined && (depth === "deep" || item.depth === "core"));
}

/** One answer as the person gave it, readable: the option chosen, the order ranked, or the text. */
function said(item: InterviewItem, answer: string | number | string[]): string {
	if (Array.isArray(answer)) return answer.map((a, i) => `${i + 1}. ${a}`).join("; ");
	if (item.kind === "likert" && typeof answer === "number") return `${answer} on a scale from 1 (strongly disagree) to 5 (strongly agree)`;
	if (item.kind === "choice" && typeof answer === "number") return item.options?.[answer] ?? String(answer);
	return String(answer);
}

/** The answered questions as one source: each question and what the person answered. */
export function answersAsSource(answers: InterviewAnswers): Omit<Source, "id"> | undefined {
	const lines = ITEM_BANK.filter((item) => answers[item.id] !== undefined).map((item) => `Q: ${item.question}\nA: ${said(item, answers[item.id]!)}`);
	return lines.length ? { kind: "answer", label: "interview answers", text: lines.join("\n\n") } : undefined;
}
