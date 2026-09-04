/**
 * The prefix is the same on the second turn as on the first.
 *
 * A prompt cache is a PREFIX match. The provider charges 1.25x to write one and 0.1x
 * to read it, and the discount stops at the first token that differs. So the only
 * thing that makes caching real is discipline about ordering, and the only thing that
 * keeps that discipline is a test, because breaking it costs nothing visible: the
 * answers stay correct and the bill goes up.
 *
 * What was wrong before E5, and it was silent: recent memory lived INSIDE the identity
 * message. Memory changes every time a turn is recorded, so the prefix differed at the
 * memory block on every turn, and the guard, the identity document and the awareness
 * block were re-read from scratch each time. Nothing was broken. Everything was paid
 * for twice.
 *
 * These tests read what the agent actually sent rather than what it says it composes,
 * because "what goes on the wire" is the only version the provider sees.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	ALL_TOOL_PERMISSIONS,
	DEFAULT_POLICY,
	PersonaAgent,
	requestToolCall,
	type ChatMessage,
} from "../src/index.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-cache-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A persona on disk with memory, which is the volatile half. */
function personaWithMemory(memory: string): string {
	const root = join(dir, ".personaxis");
	mkdirSync(root, { recursive: true });
	const path = join(root, "personaxis.md");
	writeFileSync(path, "---\nidentity:\n  name: Tester\n---\n\nA persona.\n", "utf-8");
	writeFileSync(join(root, "memory.md"), memory, "utf-8");
	writeFileSync(
		join(root, "state.json"),
		JSON.stringify({ schema_version: "1.0.0", persona_id: "p", persona_version: "1", values: {}, mutation_log: [] }),
		"utf-8",
	);
	return path;
}

/** Runs one turn and hands back the messages that went out. */
async function sent(
	personaPath: string,
	task: string,
	extra: Partial<ConstructorParameters<typeof PersonaAgent>[0]> = {},
): Promise<ChatMessage[]> {
	let captured: ChatMessage[] = [];
	const agent = new PersonaAgent({
		llm: {
			endpoint: "http://x/v1",
			model: "m",
			fetchImpl: (async (url: string, init: { body: string }) => {
				if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
				const body = JSON.parse(init.body) as { messages: ChatMessage[] };
				if (captured.length === 0) captured = body.messages;
				return {
					ok: true,
					status: 200,
					headers: new Headers({ "content-type": "application/json" }),
					json: async () => ({
						choices: [
							{
								message: {
									content: "",
									tool_calls: [
										{ id: "c1", type: "function", function: { name: "finish", arguments: '{"summary":"done"}' } },
									],
								},
							},
						],
					}),
				};
			}) as unknown as typeof fetch,
		},
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access" },
		personaBody: "You are Tester.",
		personaPath,
		...extra,
	});
	await agent.run(task);
	return captured;
}

describe("what the loop puts before what", () => {
	it("keeps the identity message identical when memory changes", async () => {
		// The whole point. Two turns of the same session, different memory, and the
		// cacheable prefix has to be byte-identical or the cache never reads.
		const path = personaWithMemory("The user prefers concise answers.");
		const first = await sent(path, "one");

		writeFileSync(join(dir, ".personaxis", "memory.md"), "Something new the persona learned.", "utf-8");
		const second = await sent(path, "two");

		expect(first[0]?.content).toBe(second[0]?.content);
		expect(first[0]?.content).toContain("# Identity");
	});

	it("puts what the persona remembers in its own message, not in the identity", async () => {
		// If memory is inside the identity message, the assertion above can only pass
		// by memory never changing, which is not a property this product has.
		const path = personaWithMemory("A memorable fact about the user.");
		const messages = await sent(path, "one");

		expect(messages[0]?.content).not.toContain("A memorable fact");
		const memoryMessage = messages.find((message) => message.content.includes("A memorable fact"));
		expect(memoryMessage?.role).toBe("system");
	});

	it("keeps every volatile message after every stable one", async () => {
		// The ordering rule stated as itself. A volatile message ahead of a stable one
		// makes the stable one uncacheable too, which is the failure that costs money
		// without changing a single answer.
		const path = personaWithMemory("Remembered.");
		const messages = await sent(path, "one");

		const volatile = messages.findIndex((message) => message.content.includes("Remembered."));
		expect(volatile).toBeGreaterThan(0);
		expect(messages.slice(0, volatile).every((message) => message.role === "system")).toBe(true);
	});

	it("puts memory after a skill guide, because a guide is fixed for the session too", async () => {
		// The control that was missing. Every assertion above passes with memory ahead
		// of the guides, because both are system messages, and the ordering rule is not
		// about roles: it is about what CHANGES. A guide is chosen once and re-read all
		// session; memory moves every turn. Memory in front of it drops the guide out
		// of the cacheable prefix, silently, for exactly the personas that have the
		// most to cache.
		const path = personaWithMemory("A memorable fact about the user.");
		const messages = await sent(path, "please write a report", {
			skills: [{ name: "reporting", capabilities: ["report"], allowedTools: ["write_file"] }],
			skillGuides: new Map([["reporting", { name: "reporting", guide: "How to write a report." }]]),
		});

		const guide = messages.findIndex((message) => message.content.includes("How to write a report"));
		const memory = messages.findIndex((message) => message.content.includes("A memorable fact"));
		expect(guide, "the guide should be on the wire at all").toBeGreaterThanOrEqual(0);
		expect(memory).toBeGreaterThan(guide);
	});

	it("still sends the memory, because a stable prefix that dropped it would be cheaper and wrong", async () => {
		// The control against the easy way to pass every test above.
		const path = personaWithMemory("The user's dog is called Ada.");
		const messages = await sent(path, "one");

		expect(messages.some((message) => message.content.includes("Ada"))).toBe(true);
	});
});

describe("the scope of the moment, which is not part of the identity", () => {
	it("keeps the confinement out of the system prompt", async () => {
		// E20, the finding that cuts against us and is measured: with the confinement
		// mode in the stable system prompt, five of twelve turns ended with no tool call
		// at all. A system prompt is who you are, and a restriction written there reads
		// as part of the identity.
		const path = personaWithMemory("nothing in particular");
		const messages = await sent(path, "one");

		expect(messages[0]?.content).not.toContain("sandbox:");
		expect(messages[0]?.content).toContain("# Identity");
	});

	it("still tells the persona what it may do right now", async () => {
		// The control, and it is the point: the answer is not to hide the limits. A
		// persona that does not know its posture guesses, acts, and is refused for
		// guessing wrong, which is worse than being told.
		const path = personaWithMemory("nothing in particular");
		const messages = await sent(path, "one");
		const scope = messages.find((message) => message.content.includes("# Right now"));

		expect(scope?.role).toBe("system");
		expect(scope?.content).toContain("sandbox: danger-full-access");
	});

	it("says it is about the turn and not about the persona", async () => {
		// The sentence is doing the work the placement cannot do alone. Moving text and
		// leaving it reading like a description of the agent would move the problem.
		const path = personaWithMemory("nothing in particular");
		const messages = await sent(path, "one");
		const scope = messages.find((message) => message.content.includes("# Right now"));

		expect(scope?.content).toContain("not a description of who you are");
	});

	it("keeps the identity byte-identical when the posture changes", async () => {
		// Which is E5's rule arriving at the same place from the other side: the posture
		// moves when somebody presses shift+tab, so anything holding it in the prefix
		// breaks the cache on every change.
		const path = personaWithMemory("nothing in particular");
		const permissive = await sent(path, "one");
		const restricted = await sent(path, "two", {
			policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "read-only" },
			// Read-only would otherwise leave the catalogue without a writer, which is E12
			// working and not what this test is about.
			permissions: ALL_TOOL_PERMISSIONS,
		});

		expect(permissive[0]?.content).toBe(restricted[0]?.content);
		expect(restricted.some((message) => message.content.includes("sandbox: read-only"))).toBe(true);
	});
});

describe("the cache breakpoint, for providers whose cache is explicit", () => {
	/** The body one request put on the wire. */
	async function bodyOf(config: { cachePrefix?: boolean }, messages: ChatMessage[]) {
		let sentBody: { messages: Array<{ role: string; content: unknown }> } = { messages: [] };
		await requestToolCall(
			{
				endpoint: "http://x/v1",
				model: "m",
				...config,
				fetchImpl: (async (_url: string, init: { body: string }) => {
					sentBody = JSON.parse(init.body);
					return {
						ok: true,
						status: 200,
						headers: new Headers({ "content-type": "application/json" }),
						json: async () => ({ choices: [{ message: { content: "ok" } }] }),
					};
				}) as unknown as typeof fetch,
			},
			messages,
			[],
		);
		return sentBody;
	}

	const three: ChatMessage[] = [
		{ role: "system", content: "identity" },
		{ role: "system", content: "guides" },
		{ role: "system", content: "memory" },
		{ role: "user", content: "hello" },
	];

	it("marks the last leading system message, so everything before it is covered", async () => {
		// One breakpoint, on the last one. A mark on the first of three would leave the
		// other two paying full price on every turn.
		const body = await bodyOf({ cachePrefix: true }, three);

		expect(body.messages[0]?.content).toBe("identity");
		expect(body.messages[2]?.content).toEqual([
			{ type: "text", text: "memory", cache_control: { type: "ephemeral" } },
		]);
	});

	it("never marks past the first user message", async () => {
		// Per-turn text starts there. Marking it would ask the provider to cache
		// something that differs on every request: a write every time and never a read.
		const body = await bodyOf({ cachePrefix: true }, three);

		expect(body.messages[3]).toEqual({ role: "user", content: "hello" });
	});

	it("sends plain text when nobody asked, because a provider that does not know the field rejects it", async () => {
		// Off by default is the careful direction. One family of provider caches any
		// repeated prefix on its own; the other rejects a marking it does not know, and
		// a cost optimisation must not become a 400 on somebody's local runtime.
		const body = await bodyOf({}, three);

		expect(body.messages[2]?.content).toBe("memory");
	});

	it("leaves a transcript with no system message alone", async () => {
		const body = await bodyOf({ cachePrefix: true }, [{ role: "user", content: "hello" }]);

		expect(body.messages[0]).toEqual({ role: "user", content: "hello" });
	});
});
