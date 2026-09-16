/**
 * E88: reading the lesson a persona says it learned, without ever inventing one.
 *
 * The rule these pin is the one `E83` set for routes and this row repeats for skills: a reply that cannot be
 * read leaves nothing behind. A lesson the runtime made up would be written into the persona's own folder, as
 * a skill it supposedly wrote, and it would be durable.
 */
import { describe, expect, it } from "vitest";

import { LESSON_INSTRUCTION, parseLesson } from "../src/run/lesson.js";

const good = JSON.stringify({
	reusable: true,
	name: "Fix a crashing page",
	description: "when a page dies a few seconds in",
	capabilities: ["debugging a browser game"],
	allowed_tools: ["read_file", "check_page"],
	body: "1. Run the page for ten seconds.\n2. Read the first error.\n3. Fix the call it names.",
});

describe("what the persona is asked (E88)", () => {
	it("asks about the method, and offers saying no in one word", () => {
		expect(LESSON_INSTRUCTION).toContain("reusable");
		expect(LESSON_INSTRUCTION).toContain("a method that fits one job is a note about that job");
	});

	it("asks for the fields a skill file actually has", () => {
		for (const field of ["name", "description", "capabilities", "allowed_tools", "body"]) {
			expect(LESSON_INSTRUCTION).toContain(field);
		}
	});
});

describe("reading the lesson back (E88)", () => {
	it("reads a well formed answer", () => {
		const read = parseLesson(good);

		expect(read.ok).toBe(true);
		expect(read.ok && read.lesson).toMatchObject({
			name: "Fix a crashing page",
			capabilities: ["debugging a browser game"],
			allowedTools: ["read_file", "check_page"],
		});
	});

	it("forgives a code fence and a sentence around the object, which is packaging and not a different answer", () => {
		const read = parseLesson("Sure, here it is:\n```json\n" + good + "\n```\nHope that helps.");

		expect(read.ok).toBe(true);
	});

	it("keeps nothing when the persona says the method is not worth keeping", () => {
		const read = parseLesson(JSON.stringify({ reusable: false, name: "x", body: "y" }));

		expect(read.ok).toBe(false);
		expect(!read.ok && read.error).toContain("not worth keeping");
	});

	it("keeps nothing when the question was never answered, because absent is not yes", () => {
		// A model that never considered it should not leave a skill behind by omission.
		const read = parseLesson(JSON.stringify({ name: "x", body: "y" }));

		expect(read.ok).toBe(false);
	});

	it("refuses a lesson with no name and one with no method, rather than writing the gap", () => {
		expect(parseLesson(JSON.stringify({ reusable: true, body: "steps" })).ok).toBe(false);
		expect(parseLesson(JSON.stringify({ reusable: true, name: "x" })).ok).toBe(false);
	});

	it("says what went wrong instead of guessing, for silence and for a reply with no object in it", () => {
		expect(parseLesson("   ")).toMatchObject({ ok: false, error: "the reply was empty" });
		expect(parseLesson("I think we learned a lot today")).toMatchObject({ ok: false, error: "the reply held no JSON object" });
		expect(parseLesson("{ not json }")).toMatchObject({ ok: false, error: "the JSON object could not be read" });
	});

	it("caps what it keeps, so one long-winded reply cannot write a skill nobody will read", () => {
		const read = parseLesson(
			JSON.stringify({
				reusable: true,
				name: "x".repeat(200),
				description: "d".repeat(500),
				capabilities: Array.from({ length: 40 }, (_, i) => `c${i}`),
				allowed_tools: Array.from({ length: 40 }, (_, i) => `t${i}`),
				body: "b".repeat(9000),
			}),
		);

		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.lesson.name.length).toBeLessThanOrEqual(60);
		expect(read.lesson.description.length).toBeLessThanOrEqual(200);
		expect(read.lesson.capabilities.length).toBeLessThanOrEqual(12);
		expect(read.lesson.body.length).toBeLessThanOrEqual(4000);
	});

	it("drops anything in the lists that is not a string, without dropping the lesson", () => {
		const read = parseLesson(JSON.stringify({ reusable: true, name: "n", body: "b", capabilities: ["ok", 3, null], allowed_tools: [] }));

		expect(read.ok && read.lesson.capabilities).toEqual(["ok"]);
	});
});
