/**
 * Continuity across turns, through the path that ships.
 *
 * The claim these pin is old and the route to it is new. A persona has to carry what
 * was already said into the next turn, and the REPL had been getting that by reading
 * `PersonaAgent.lastMessages` after each run: a consumer reaching past the seam for the
 * one thing the seam cannot carry, because a scripted provider has no messages and a
 * transcript in `TurnOutcome` would make the result describe one particular loop.
 *
 * So the session lends a `Conversation` and whatever runs the turn reads and returns
 * through it. These run two real turns through `runnerFor` against a stubbed endpoint,
 * because a test that asserted the wiring by inspecting options would pass while the
 * conversation went nowhere.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inMemoryConversation } from "../src/run/conversation.js";
import { agentOptionsFor, runnerFor } from "../src/run/runner-for.js";
import { TurnRunner } from "../src/run/service.js";
import type { TurnRequest } from "../src/run/vocabulary.js";

/** An endpoint that always says one thing, so the transcript is the only variable. */
function stubLlm(reply: string) {
	const fetchImpl = (async () =>
		new Response(
			JSON.stringify({
				choices: [{ message: { content: reply } }],
				usage: { total_tokens: 10, prompt_tokens: 5 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		)) as unknown as typeof fetch;
	return { endpoint: "http://stub", model: "stub-model", fetchImpl } as never;
}

const SPEC = ["---", "identity: { canonical_id: clio }", "---", "body", ""].join("\n");

let dir: string;
let personaPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-convo-"));
	personaPath = join(dir, "personaxis.md");
	writeFileSync(personaPath, SPEC);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function asked(prompt: string): TurnRequest {
	return { turn: prompt, prompt, asker: { kind: "human", id: "david" } };
}

function facts(reply: string) {
	return { personaPath, frontmatter: {} as Record<string, unknown>, llm: stubLlm(reply) };
}

describe("what the next turn starts from", () => {
	it("carries the first exchange into the second", async () => {
		// The regression this replaces was measured on the old route: without it the
		// next turn saw only the stacked user questions and re-answered them all.
		const conversation = inMemoryConversation();

		await runnerFor(facts("ROJO"), { conversation }).run(asked("say ROJO"));
		await runnerFor(facts("AZUL"), { conversation }).run(asked("say AZUL"));

		const held = conversation.read();
		expect(held.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(held[1]!.content).toBe("ROJO");
		expect(held[3]!.content).toBe("AZUL");
	});

	it("does not carry the system message forward", async () => {
		// It is built fresh for every request from the persona's current identity, so
		// keeping the old one hands the model a description of who this persona used to
		// be. Two turns, because one would pass on a transcript that never had one.
		const conversation = inMemoryConversation();

		await runnerFor(facts("one"), { conversation }).run(asked("first"));
		await runnerFor(facts("two"), { conversation }).run(asked("second"));

		expect(conversation.read().some((m) => m.role === "system")).toBe(false);
	});

	it("keeps what was said when the turn ended badly", async () => {
		// A turn that failed still put a question to the model. Dropping its messages
		// would make the next one ask it again, and the person would be charged twice
		// for the same words.
		const conversation = inMemoryConversation();
		const exploding = {
			personaPath,
			frontmatter: {} as Record<string, unknown>,
			llm: {
				endpoint: "http://stub",
				model: "stub-model",
				fetchImpl: (async () => {
					throw new Error("the model hung up");
				}) as unknown as typeof fetch,
			} as never,
		};

		const outcome = await runnerFor(exploding, { conversation }).run(asked("say something"));

		expect(outcome.stopReason).not.toBe("answered");
		expect(conversation.read().map((m) => m.role)).toContain("user");
	});

	it("is left alone by a loop that keeps no transcript", async () => {
		// A provider with nothing to say about what was said says nothing. The
		// continuity it cannot offer is honestly absent rather than quietly emptied.
		const conversation = inMemoryConversation([{ role: "user", content: "from before" }]);
		const runner = new TurnRunner({
			provider: { name: "scripted", run: async () => ({ answer: "ok", steps: 1 }) },
		});

		await runner.run(asked("anything"));

		expect(conversation.read()).toEqual([{ role: "user", content: "from before" }]);
	});
});

describe("who owns the conversation", () => {
	it("hands the loop exactly what the session holds", () => {
		// Read here rather than by the caller. Two ways to say it is two owners: a
		// session could lend one transcript and keep a different one, with nothing to
		// say which was the conversation.
		const conversation = inMemoryConversation([{ role: "user", content: "earlier" }]);

		expect(agentOptionsFor(facts("x"), { conversation }).priorMessages).toEqual([
			{ role: "user", content: "earlier" },
		]);
	});

	it("has no second way for a caller to pass one", () => {
		// `priorMessages` is off the session type, so this is the compiler's rule as
		// well as this file's. Written as a runtime check too, because the type is what
		// somebody widens and this is what tells them why it was narrow.
		const conversation = inMemoryConversation([{ role: "user", content: "the real one" }]);
		const options = agentOptionsFor(facts("x"), {
			conversation,
			priorMessages: [{ role: "user", content: "a second one" }],
		} as never);

		expect(options.priorMessages).toEqual([{ role: "user", content: "the real one" }]);
	});

	it("gives a loop that reads it a copy, not the session's own list", () => {
		// A provider that sorted or spliced what it was handed would be editing the
		// session's history in place, and nothing would say it had happened.
		const conversation = inMemoryConversation([{ role: "user", content: "earlier" }]);
		const lent = agentOptionsFor(facts("x"), { conversation }).priorMessages!;

		lent.length = 0;

		expect(conversation.read()).toHaveLength(1);
	});
});
