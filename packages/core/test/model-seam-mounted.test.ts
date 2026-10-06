/**
 * The seam, on the road: a destination declares, and the caller reads the declaration.
 *
 * `model-seam.ts` has been written since phase 4 with `resolveEffort`, `forDestination`
 * and `EFFORT_LADDER`, and nothing declared anything, so the rule had no data to run
 * on. E8 gives it a table and puts it in front of every request.
 *
 * The bug this whole subsystem exists to prevent is worth naming because it is
 * invisible: an unrecognised effort level that fell back to a weak default, so asking
 * for the MAXIMUM resolved weaker than asking for a middle level. A ladder inversion,
 * and one that costs money in the direction nobody checks. The rule is keep the level
 * when it is supported, step DOWN to the nearest supported one otherwise, and never
 * step up.
 */

import { describe, expect, it } from "vitest";

import { capabilitiesFor } from "../src/run/destinations.js";
import {
	EFFORT_LADDER,
	forDestination,
	mayReplay,
	resolveEffort,
	type Effort,
} from "../src/run/model-seam.js";
import { requestToolCall } from "../src/tool-calling.js";

/**
 * A destination that declares whatever this test needs.
 *
 * Written here rather than importing the module's own fallback, which is not
 * exported: it is the shape of an absence, and exporting it would be an export with
 * no caller. The sweep that watches for those caught exactly that, correctly.
 */
const declaring = (effort: readonly Effort[]) => ({
	id: "test",
	effort,
	foreignReasoning: false,
	cacheSeconds: 0,
	rejects: [] as readonly string[],
});

/** The body one request actually put on the wire. */
async function bodyOf(config: Partial<Parameters<typeof requestToolCall>[0]> = {}) {
	let sent: Record<string, unknown> = {};
	await requestToolCall(
		{
			endpoint: "http://local:1234/v1",
			model: "llama-3-8b",
			...config,
			fetchImpl: (async (_url: string, init: { body: string }) => {
				sent = JSON.parse(init.body);
				return {
					ok: true,
					status: 200,
					headers: new Headers({ "content-type": "application/json" }),
					json: async () => ({ choices: [{ message: { content: "ok" } }] }),
				};
			}) as unknown as typeof fetch,
		} as Parameters<typeof requestToolCall>[0],
		[],
		[],
	);
	return sent;
}

describe("what a destination is asked for", () => {
	it("sends no effort field to a destination that declared none", async () => {
		// The ordinary case, and the safe direction. A local runtime somebody started
		// this morning rejects a field it does not know with a 400, and that is the
		// endpoint least likely to know one.
		const body = await bodyOf({ effort: "high" });

		expect(body.reasoning_effort).toBeUndefined();
	});

	it("sends the level a destination does declare", async () => {
		const body = await bodyOf({
			endpoint: "https://api.openai.com/v1",
			model: "o3-mini",
			effort: "high",
		});

		expect(body.reasoning_effort).toBe("high");
	});

	it("steps down to the nearest supported level, never up", async () => {
		// `max` is not in OpenAI's vocabulary. Sending it would be a 400; swapping it
		// for `low` because it is the first thing in the list would be the inversion.
		const body = await bodyOf({
			endpoint: "https://api.openai.com/v1",
			model: "o3-mini",
			effort: "max",
		});

		expect(body.reasoning_effort).toBe("high");
	});

	it("sends nothing at all when nobody asked for an effort", async () => {
		const body = await bodyOf({ endpoint: "https://api.openai.com/v1", model: "o3-mini" });

		expect(body.reasoning_effort).toBeUndefined();
	});

	it("tells the caller when it had to step down", async () => {
		// A downgrade nobody can see is a downgrade somebody argues about later, having
		// paid for a level they believe they asked for.
		const seen: Array<{ from: string; to: string | undefined; where: string }> = [];
		await bodyOf({
			endpoint: "https://api.openai.com/v1",
			model: "o3-mini",
			effort: "max",
			onEffortDowngrade: (from, to, where) => seen.push({ from, to, where }),
		});

		expect(seen).toEqual([{ from: "max", to: "high", where: "openai-reasoning:o3-mini" }]);
	});

	it("tells the caller when the level was dropped entirely", async () => {
		const seen: Array<string | undefined> = [];
		await bodyOf({ effort: "high", onEffortDowngrade: (_from, to) => seen.push(to) });

		expect(seen).toEqual([undefined]);
	});

	it("says nothing when the level went through untouched", async () => {
		const seen: unknown[] = [];
		await bodyOf({
			endpoint: "https://api.openai.com/v1",
			model: "o3-mini",
			effort: "medium",
			onEffortDowngrade: (from, to) => seen.push([from, to]),
		});

		expect(seen).toEqual([]);
	});
});

describe("the ladder itself", () => {
	it("never resolves upward, whatever is asked against whatever is offered", () => {
		// The property rather than an example. Every pair of asked level and declared
		// set, and no combination may come back stronger than what was asked for: that
		// is the bill nobody can explain.
		for (const asked of EFFORT_LADDER) {
			for (let size = 1; size <= EFFORT_LADDER.length; size += 1) {
				const offered = EFFORT_LADDER.slice(0, size);
				const { effort } = resolveEffort(asked, declaring(offered));
				if (effort === undefined) continue;
				expect(
					EFFORT_LADDER.indexOf(effort),
					`asked ${asked} against [${offered.join(",")}] and got ${effort}`,
				).toBeLessThanOrEqual(EFFORT_LADDER.indexOf(asked));
			}
		}
	});

	it("takes the weakest available when nothing below is offered", () => {
		// Asking for `minimal` from a destination that only takes `high`. Still a
		// downgrade in spirit, and reported as one, because the alternative is sending
		// nothing and losing the request.
		const resolved = resolveEffort("minimal", declaring(["high"]));

		expect(resolved.effort).toBe("high");
		expect(resolved.downgradedFrom).toBe("minimal");
	});

	it("resolves to nothing when a destination takes no effort at all", () => {
		expect(resolveEffort("high", declaring([])).effort).toBeUndefined();
	});
});

describe("what the table declares, and what it refuses to guess", () => {
	it("gives an unlisted destination nothing", () => {
		// Silence means no. A model gains a capability by being added on purpose, and
		// never by resembling one that has it.
		const local = capabilitiesFor("http://localhost:11434/v1", "qwen2.5-coder");

		expect(local.effort).toEqual([]);
		expect(local.cacheSeconds).toBe(0);
		expect(local.foreignReasoning).toBe(false);
	});

	it("matches on the model before the endpoint, on the same host", () => {
		// The case that actually distinguishes the two orderings, and the first version
		// of this test did not: it compared a reasoning model on an UNLISTED gateway
		// against a plain model on OpenAI, where either ordering gives the same answer.
		// Both of these are api.openai.com, and only the model tells them apart.
		const reasoning = capabilitiesFor("https://api.openai.com/v1", "o3-mini");
		const plain = capabilitiesFor("https://api.openai.com/v1", "gpt-4o-mini");

		expect(reasoning.effort).toContain("high");
		expect(plain.effort).toEqual([]);
	});

	it("recognises a model behind a gateway it has never heard of", () => {
		// A proxy answers on its own URL. The model name is the specific fact and it
		// survives the hop; the hostname does not.
		expect(capabilitiesFor("https://gateway.example.com/v1", "o3-mini").effort).toContain("high");
	});

	it("names the model in the destination id, so two models are two destinations", () => {
		// Which is what `mayReplay` needs: reasoning issued by one model is not
		// reasoning the next one can be handed back.
		expect(capabilitiesFor("https://api.openai.com/v1", "o3-mini").id).toBe("openai-reasoning:o3-mini");
		expect(capabilitiesFor("http://local/v1", "mystery").id).toBe("unknown:mystery");
	});

	it("lets a destination replay its own reasoning and not somebody else's", () => {
		const openai = capabilitiesFor("https://api.openai.com/v1", "o3-mini");

		expect(mayReplay(openai.id, openai)).toBe(true);
		expect(mayReplay("anthropic:claude", openai)).toBe(false);
	});
});

describe("what shaping a request must not do", () => {
	it("copies rather than trimming what it was given", () => {
		// Their bug, generalised into a rule: a sanitiser that mutated in place held a
		// reference to the shared tool registry, so the first request to one strict
		// provider left that registry permanently trimmed for every later call to every
		// other provider.
		const messages = [{ role: "user", text: "hello" }];
		const tools = ["read_file"];
		const request = { destination: "x", effort: "high" as const, messages, tools };

		const shaped = forDestination(request, capabilitiesFor("https://api.openai.com/v1", "o3-mini"));
		shaped.messages[0]!.text = "changed";

		expect(messages[0]!.text).toBe("hello");
		expect(shaped.tools).not.toBe(tools);
	});
});
