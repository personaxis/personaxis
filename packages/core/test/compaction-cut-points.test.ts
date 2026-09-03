/**
 * When a transcript may be rewritten, and what a rewrite is not allowed to touch.
 *
 * Two things E6 changed, and the first one was a live defect rather than a design
 * preference.
 *
 * **Compaction kept ONE system message and dropped the rest.** `messages.find(m =>
 * m.role === "system")`. That already cost a persona its skill guides on any long
 * run, and E5 made it worse by splitting the prompt into three: identity, guides, and
 * what the persona remembers. Compaction kept the first and threw the other two away,
 * so a long session quietly turned into a persona with no memory and no skills, still
 * answering, still sounding fine.
 *
 * **Compaction ran on any step past the threshold.** Which is "somewhere in the middle
 * of the work, whenever". A summarised transcript is a different transcript, so every
 * token after the prefix has to be re-read: the compaction that saved context spent
 * the cache. Now there are two named cut points and each one is counted, because E6's
 * whole claim is that this is measured rather than supposed.
 */

import { describe, expect, it } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	compactMessages,
	ContextMeter,
	DEFAULT_POLICY,
	PersonaAgent,
	type ChatMessage,
} from "../src/index.js";

/** A summariser that answers, so the compaction actually happens. */
const summariser = {
	endpoint: "http://x/v1",
	model: "m",
	fetchImpl: (async () => ({
		ok: true,
		status: 200,
		json: async () => ({ choices: [{ message: { content: "a condensed history" } }] }),
	})) as unknown as typeof fetch,
};

/** A transcript with a three-message prefix and enough history to compact. */
function transcript(turns: number): ChatMessage[] {
	return [
		{ role: "system", content: "# Identity\nYou are Tester." },
		{ role: "system", content: "# Skill guide\nHow to write a report." },
		{ role: "system", content: "# Recent memory\nThe user's dog is called Ada." },
		...Array.from({ length: turns }, (_, index) => ({
			role: (index % 2 === 0 ? "user" : "assistant") as ChatMessage["role"],
			content: `turn ${index}`,
		})),
	];
}

/** The window every test here works against. Small, so a transcript can fill it. */
const WINDOW = 1000;

/** A meter that reports the window as this full. */
function meterAt(fraction: number): ContextMeter {
	const meter = new ContextMeter(WINDOW);
	meter.used = Math.round(WINDOW * fraction);
	return meter;
}

/** A model name nobody else used, because the window resolver caches by model. */
let models = 0;
const freshModel = () => `m-${(models += 1)}`;

describe("what a compaction may not throw away", () => {
	it("keeps every leading system message, not just the first", async () => {
		// The defect. One `find` kept the identity and dropped the guides and the
		// memory, and nothing failed: the persona kept answering, without either.
		const result = await compactMessages(transcript(30), meterAt(0.9), {
			llm: summariser,
			threshold: 0.8,
		});

		expect(result.compacted).toBe(true);
		const kept = result.messages.filter((message) => message.role === "system").map((m) => m.content);
		expect(kept.some((content) => content.includes("# Identity"))).toBe(true);
		expect(kept.some((content) => content.includes("# Skill guide"))).toBe(true);
		expect(kept.some((content) => content.includes("Ada"))).toBe(true);
	});

	it("keeps the prefix in its original order, because that order is the cache", async () => {
		// E5's rule read from the other side. The prefix is what a provider matched
		// last time, so a compaction that reordered it would invalidate the very thing
		// it left alone.
		const result = await compactMessages(transcript(30), meterAt(0.9), {
			llm: summariser,
			threshold: 0.8,
		});

		expect(result.messages[0]?.content).toContain("# Identity");
		expect(result.messages[1]?.content).toContain("# Skill guide");
		expect(result.messages[2]?.content).toContain("Ada");
	});

	it("still removes the history, which is the point of doing it at all", async () => {
		// The control against the easy way to pass both tests above: keep everything.
		const before = transcript(30);
		const result = await compactMessages(before, meterAt(0.9), { llm: summariser, threshold: 0.8 });

		expect(result.messages.length).toBeLessThan(before.length);
		expect(result.removed).toBeGreaterThan(0);
		expect(result.messages.some((message) => message.content.includes("a condensed history"))).toBe(true);
	});

	it("does nothing below the threshold, so an ordinary turn pays nothing", async () => {
		const before = transcript(30);
		const result = await compactMessages(before, meterAt(0.4), { llm: summariser, threshold: 0.8 });

		expect(result.compacted).toBe(false);
		expect(result.messages).toBe(before);
	});

	it("leaves the transcript untouched when the summariser fails", async () => {
		// Best-effort by design: a summariser that is down must not end a session. The
		// interesting half is that it returns the ORIGINAL messages, prefix included,
		// rather than a half-applied rewrite.
		const before = transcript(30);
		const result = await compactMessages(before, meterAt(0.9), {
			llm: {
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: (async () => {
					throw new Error("summariser is down");
				}) as unknown as typeof fetch,
			},
			threshold: 0.8,
		});

		expect(result.compacted).toBe(false);
		expect(result.messages).toBe(before);
	});

	it("survives a transcript that is nothing but its prefix", async () => {
		// A session where nobody has said anything yet. There is no history to remove,
		// and a compaction that summarised the prefix would delete the persona.
		const onlyPrefix = transcript(0);
		const result = await compactMessages(onlyPrefix, meterAt(0.99), {
			llm: summariser,
			threshold: 0.8,
		});

		expect(result.compacted).toBe(false);
		expect(result.messages).toBe(onlyPrefix);
	});
});

/**
 * A model that keeps proposing a harmless call, so the run reaches many steps.
 *
 * `steps` decides when it finishes, because a compaction at a cut point past the
 * first one can only be observed on a run that got past the first one.
 */
function walking(steps: number, model: string): typeof fetch {
	let seen = 0;
	return (async (url: string, init?: { body?: string }) => {
		// The window, answered rather than guessed.
		//
		// The loop refines  from the endpoint in the background, so a test
		// that only set the meter would have its number overwritten by the table default
		// mid-run, and the compaction it was arranging would never trigger. Measured the
		// hard way: the first four assertions here failed against an empty model list.
		if (String(url).endsWith("/models")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({ data: [{ id: model, context_length: WINDOW }] }),
			};
		}
		seen += 1;
		// The summariser goes to the same endpoint, and it REFUSES an empty answer:
		// `compactMessages` catches that and returns `compacted: false`. So a model that
		// replied with nothing but a tool call made every assertion below read as "the
		// cut point did not fire", which is a fixture failing and looking like a finding.
		if (String(init?.body ?? "").includes("compress conversations")) {
			return {
				ok: true,
				status: 200,
				headers: new Headers({ "content-type": "application/json" }),
				json: async () => ({ choices: [{ message: { content: "a condensed history" } }] }),
			};
		}
		const call =
			seen >= steps
				? { name: "finish", arguments: '{"summary":"done"}' }
				: { name: "list_dir", arguments: '{"path":"."}' };
		return {
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => ({
				choices: [{ message: { content: "", tool_calls: [{ id: `c${seen}`, type: "function", function: call }] } }],
			}),
		};
	}) as unknown as typeof fetch;
}

/** A run against a window this full, reporting what it compacted. */
async function runAt(fraction: number, steps: number) {
	const dir = mkdtempSync(join(tmpdir(), "pxs-cut-"));
	try {
		const meter = meterAt(fraction);
		const model = freshModel();
		const agent = new PersonaAgent({
			llm: { endpoint: "http://x/v1", model, fetchImpl: walking(steps, model) },
			policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access" },
			// Enough transcript that there is something to compact at all.
			priorMessages: Array.from({ length: 30 }, (_, index) => ({
				role: (index % 2 === 0 ? "user" : "assistant") as ChatMessage["role"],
				content: `earlier turn ${index}`,
			})),
			meter,
			maxSteps: steps + 2,
		});
		return await agent.run("keep going");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("where a compaction is allowed to happen", () => {
	it("compacts at the start of a turn, and says so", async () => {
		// The cheap, predictable point: before any work, where a rewrite costs least.
		const result = await runAt(0.85, 3);

		expect(result.compactions.map((entry) => entry.cut)).toEqual(["turn-start"]);
		expect(result.compactions[0]?.step).toBe(1);
	});

	it("does not compact again mid-run just because the threshold is still crossed", async () => {
		// The behaviour E6 removed. It used to run on EVERY step past the threshold, so
		// a long run rewrote its own transcript over and over, each time throwing away
		// the cache it had just paid to write.
		const result = await runAt(0.85, 6);

		expect(result.compactions).toHaveLength(1);
	});

	it("still compacts mid-run when the window fills up anyway", async () => {
		// The safety valve, and the only way to reach it is the way it happens in
		// practice: a turn that started with room and ran out of it. Written first as a
		// run that STARTED past the hard threshold, which never reaches this branch at
		// all, because the start of a turn is a cut point too and handles it first.
		//
		// Refusing here would not save a cache, it would fail the turn, and a rule that
		// costs somebody their work is a rule they switch off.
		const dir = mkdtempSync(join(tmpdir(), "pxs-cut-"));
		try {
			const meter = meterAt(0.3);
			const model = freshModel();
			const walk = walking(4, model);
			const agent = new PersonaAgent({
				llm: {
					endpoint: "http://x/v1",
					model,
					fetchImpl: (async (url: string, init?: { body?: string }) => {
						const response = await walk(url as never, init as never);
						// The window filling as the run goes: what a real provider reports
						// once a few tool results are in the transcript.
						if (!String(url).endsWith("/models")) meter.used = 950;
						return response;
					}) as unknown as typeof fetch,
				},
				policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access" },
				priorMessages: Array.from({ length: 30 }, (_, index) => ({
					role: (index % 2 === 0 ? "user" : "assistant") as ChatMessage["role"],
					content: `earlier turn ${index}`,
				})),
				meter,
				maxSteps: 6,
			});

			const result = await agent.run("keep going");
			expect(result.compactions.map((entry) => entry.cut)).toContain("window-full");
			expect(result.compactions.every((entry) => entry.cut !== "turn-start")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports what each compaction cost, rather than that one happened", async () => {
		// E6's claim is that this is measured. A boolean would say a compaction
		// occurred and nothing about whether it was worth it.
		const result = await runAt(0.85, 3);

		const first = result.compactions[0];
		expect(first?.removed).toBeGreaterThan(0);
		expect(first?.before).toBeGreaterThan(0);
		expect(first?.after).toBeLessThan(first!.before);
	});

	it("reports an empty list when nothing was compacted", async () => {
		// Not the same as never measuring. A caller cannot tell those apart from a
		// count alone, which is why the list is always present.
		const result = await runAt(0.2, 2);

		expect(result.compactions).toEqual([]);
	});
});
