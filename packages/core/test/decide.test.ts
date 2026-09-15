/**
 * E83: reading the decision a small model writes before acting, the note it reads back, and which scaffold
 * a destination gets.
 */
import { describe, expect, it } from "vitest";

import { DECIDE_INSTRUCTION, describeDecision, parseDecision } from "../src/run/decide.js";

/** Written out rather than imported: the list the module keeps to itself, as a reader of the instruction sees it. */
const ROUTES = ["answer", "ask", "consult", "skills", "delegate", "work"] as const;
import { scaffoldFor } from "../src/run/destinations.js";

describe("reading a decision (E83)", () => {
	it("reads the object, with or without packaging around it", () => {
		expect(parseDecision('{"route": "consult", "why": "the sources are in my reference"}')).toEqual({
			ok: true,
			decision: { route: "consult", why: "the sources are in my reference" },
		});
		expect(parseDecision('Sure.\n```json\n{"route": "Work", "why": "three files"}\n```')).toEqual({
			ok: true,
			decision: { route: "work", why: "three files" },
		});
	});

	it("keeps a decision with no reason, and says nothing in its place", () => {
		expect(parseDecision('{"route": "answer"}')).toEqual({ ok: true, decision: { route: "answer", why: "" } });
	});

	it("refuses a route that is not one of them instead of picking the nearest", () => {
		const read = parseDecision('{"route": "research", "why": "look it up"}');
		expect(read.ok).toBe(false);
		expect(read.ok ? "" : read.error).toContain('"research" is not one of the routes');
	});

	it("refuses a reply with no object, and an empty one", () => {
		expect(parseDecision("I will read my reference first.").ok).toBe(false);
		expect(parseDecision("   ").ok).toBe(false);
	});

	it("asks with every route and reads back what the chosen one means", () => {
		for (const route of ROUTES) expect(DECIDE_INSTRUCTION).toContain(`- ${route}:`);
		const note = describeDecision({ route: "consult", why: "sources" });
		expect(note).toContain("You decided this request needs: consult (sources)");
		expect(note).toContain("read it before replying");
		expect(note).toContain("Every tool is still yours");
	});
});

describe("the scaffold a run gets (E83)", () => {
	it("is standard where nobody declared one, which is the loop unchanged", () => {
		expect(scaffoldFor({ endpoint: "https://router.huggingface.co/v1", model: "Qwen/Qwen3-4B-Instruct-2507" })).toBe("standard");
		expect(scaffoldFor({ endpoint: "https://api.openai.com/v1", model: "gpt-5" })).toBe("standard");
	});

	it("takes the model's own settings over the table", () => {
		expect(scaffoldFor({ endpoint: "https://api.openai.com/v1", model: "gpt-5", scaffold: "small" })).toBe("small");
	});
});
