/**
 * One way to get a runner, and what it decides.
 *
 * There were two ways and they had drifted. The REPL and the SDK each assembled a
 * `PersonaAgent` by hand, both re-deriving the same facts from the same file, and
 * the SDK's copy had quietly fallen behind: no awareness block, no goal, no session
 * id, no meter. A persona answering through the SDK did not know what it knew in the
 * REPL, and nothing anywhere said so.
 *
 * What these pin is the split. The persona answers what it declared and the caller
 * cannot overrule it; everything else is the caller's and this file does not invent
 * a default for it.
 */

import { describe, expect, it, vi } from "vitest";

import { agentOptionsFor, runnerFor } from "../src/run/runner-for.js";

const llm = { endpoint: "http://model.invalid", model: "m", apiKey: "k" } as never;

/** A persona that declared limits, as one would in its spec. */
const declared = {
	personaPath: "/work/repo/.personaxis/personaxis.md",
	frontmatter: {
		agent_budget: { max_steps: 3, max_tokens: 1000 },
		verification: { mode: "blocking" },
	} as Record<string, unknown>,
	llm,
};

describe("what the persona decides and the caller cannot", () => {
	it("builds a runner without a model call", () => {
		// Construction alone, which is the point: a factory that needed a model to be
		// tested would be a factory nobody tested.
		expect(() => runnerFor(declared)).not.toThrow();
	});

	it("reads the budget from the persona, not from the caller", () => {
		// `budget` is not on the session type at all, so the compiler refuses it too.
		// This is what catches somebody widening the type later without noticing what
		// it was for.
		const options = agentOptionsFor(declared, { maxSteps: 99 } as never);

		expect(options.budget?.maxSteps).toBe(3);
	});

	it("reads the verification block from the persona", () => {
		const options = agentOptionsFor(declared);

		expect(options.verification?.mode).toBe("blocking");
	});

	it("still gives a persona that declared nothing its defaults", () => {
		// A spec with no budget block is not a spec with no budget. Deriving nothing
		// would hand the caller an agent with no ceiling at all.
		const options = agentOptionsFor({ ...declared, frontmatter: {} });

		expect(options.budget).toBeDefined();
		expect(options.verification).toBeDefined();
	});

	it("gives the judge the persona's own model", () => {
		// A different judge would mean a persona checked by something it never
		// declared, which its spec cannot support and nobody could audit from the file.
		const options = agentOptionsFor(declared);

		expect(options.judge).toBe(declared.llm);
		expect(options.llm).toBe(declared.llm);
	});

	it("does not let a caller pass a different judge", () => {
		// Written as a runtime check as well as a type one, because the type is what
		// somebody edits and this is what tells them why it was narrow.
		const options = agentOptionsFor(declared, { judge: { model: "something-else" } } as never);

		expect(options.judge).toBe(declared.llm);
	});
});

describe("what the caller keeps", () => {
	it("passes the session's own facts through, untouched", () => {
		// The four the SDK had quietly stopped passing. A persona answering there did
		// not know what it knew in the REPL, and nothing said so.
		const onApproval = vi.fn(async () => "deny" as const);
		const options = agentOptionsFor(declared, {
			personaBody: "You are Clio.",
			awareness: "it is Tuesday",
			goal: "close the ledger",
			onApproval,
			sessionId: "s1",
		} as never);

		expect(options.personaBody).toBe("You are Clio.");
		expect(options.awareness).toBe("it is Tuesday");
		expect(options.goal).toBe("close the ledger");
		expect(options.sessionId).toBe("s1");
		expect(options.onApproval).toBe(onApproval);
	});

	it("needs nothing from the session at all", () => {
		// A persona with a model and a spec is enough. Anything this required would be
		// something a hosted caller had to invent.
		expect(() => runnerFor(declared, {})).not.toThrow();
		expect(agentOptionsFor(declared).personaBody).toBeUndefined();
	});
});

describe("the seam it hands back", () => {
	it("is a runner and not an agent", () => {
		// A caller holding an agent has to be edited again when the loop behind it
		// changes. This is the whole reason the seam exists.
		const runner = runnerFor(declared);

		expect(runner).toHaveProperty("run");
		expect(runner).not.toHaveProperty("step");
	});

	it("keeps the provider private, so nobody reaches past the seam", () => {
		// `private` is not private at runtime, which is how the first version of this
		// leaked: a consumer could reach the provider and call it directly.
		const runner = runnerFor(declared);

		expect(Object.keys(runner)).not.toContain("provider");
		expect(Object.keys(runner)).not.toContain("#provider");
	});
});
