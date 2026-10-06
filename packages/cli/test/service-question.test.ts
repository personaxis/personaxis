/**
 * E84: a service step whose turn stopped at a question nobody could answer makes its run wait, with the
 * question written whole as the reason, so whoever reads the run can see what is missing.
 */
import { describe, expect, it } from "vitest";

import { waitingForAnswer } from "../src/commands/service.js";

const options = [{ label: "Plain canvas" }, { label: "Phaser" }];

describe("a service step that stopped at a question (E84)", () => {
	it("waits, with the unanswered question and its options as the reason", () => {
		expect(waitingForAnswer([{ question: "Which engine should the prototype use?", options }])).toBe(
			"waiting for an answer: Which engine should the prototype use?\n  1. Plain canvas\n  2. Phaser",
		);
	});

	it("does not wait when every question was answered, or when none was asked", () => {
		expect(waitingForAnswer([{ question: "Which engine?", options, answer: "Phaser" }])).toBeNull();
		expect(waitingForAnswer(undefined)).toBeNull();
		expect(waitingForAnswer([])).toBeNull();
	});
});
