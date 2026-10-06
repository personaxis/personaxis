/**
 * E84: reading a question the persona asks, showing it, and reading what a person typed back.
 */
import { describe, expect, it } from "vitest";

import { answerFrom, readQuestion, renderQuestion } from "../src/tools/ask-person.js";

const asked = {
	question: "Which engine should the prototype use?",
	options: [
		{ label: "Plain canvas", detail: "one file, no dependencies" },
		{ label: "Phaser", detail: "a library to load" },
	],
	recommended: "Plain canvas",
};

describe("reading a question (E84)", () => {
	it("keeps the question, its options and the recommendation when it names one of them", () => {
		expect(readQuestion(asked)).toEqual({ ok: true, question: asked });
	});

	it("drops a recommendation that is not one of the options, instead of inventing one", () => {
		const read = readQuestion({ ...asked, recommended: "Unity" });
		expect(read.ok && read.question.recommended).toBe(undefined);
	});

	it("refuses a question with fewer than two options, and says how to fix it", () => {
		const read = readQuestion({ question: "Go on?", options: [{ label: "Yes" }] });
		expect(read.ok).toBe(false);
		expect(read.ok ? "" : read.reply).toContain("at least two options");
	});

	it("refuses an empty question", () => {
		expect(readQuestion({ question: " ", options: asked.options }).ok).toBe(false);
	});

	it("keeps each option once and at most four", () => {
		const read = readQuestion({
			question: "Colour?",
			options: ["red", "red", "green", "blue", "black", "white"].map((label) => ({ label })),
		});
		expect(read.ok && read.question.options.map((option) => option.label)).toEqual(["red", "green", "blue", "black"]);
	});
});

describe("showing and answering a question (E84)", () => {
	it("numbers the options and marks the recommended one", () => {
		expect(renderQuestion(asked)).toBe(
			"Which engine should the prototype use?\n  1. Plain canvas (recommended): one file, no dependencies\n  2. Phaser: a library to load",
		);
	});

	it("reads a number or a label as that option, and anything else as the person's own words", () => {
		expect(answerFrom(asked, "2")).toBe("Phaser");
		expect(answerFrom(asked, " plain CANVAS ")).toBe("Plain canvas");
		expect(answerFrom(asked, "whatever is fastest to try")).toBe("whatever is fastest to try");
		expect(answerFrom(asked, "7")).toBe("7");
	});

	it("reads nothing typed as no answer, never as the recommendation", () => {
		expect(answerFrom(asked, "   ")).toBe("");
	});
});
