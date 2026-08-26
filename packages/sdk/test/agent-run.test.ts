/**
 * What `agentRun` answers with, and what narrowing it cost.
 *
 * It used to hand back the whole `AgentResult` of one particular loop, so a caller
 * reading `summary` and `budget.stoppedBy` was reading the shape of our loop and would
 * have got silence from anybody else's behind the same seam. It answers with a
 * `TurnOutcome` now.
 *
 * Four things are not in `TurnOutcome`, and the claim that only one of them was ever a
 * loss is the claim these check rather than assert. The specific ceiling, the
 * verification verdict and the wall clock all ride the event bus, which this still
 * returns whole. The fourth, whether the loop said it was DONE, was a real gap and it
 * was a gap in the vocabulary rather than a cost of narrowing: `answered` meant both
 * "it finished" and "it ran out of steps with something to show".
 */

import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Persona } from "../src/index.js";

const SPEC = `---
apiVersion: persona.dev/v1
metadata: { name: sdk, version: 1.0.0 }
identity: { canonical_id: sdk, display_name: Sdk }
improvement_policy: { mode: suggesting }
memory: { types: { episodic: true } }
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-1, 1] }
verification:
  mode: advisory
  gates:
    - { type: predicate, name: says-something, kind: contains, expr: "" }
---
You are Sdk, a support persona.
`;

let dir: string;
let personaPath: string;
let saved: Record<string, string | undefined>;

/**
 * A local endpoint that replies once with prose, so the loop finishes in one step.
 *
 * A stub rather than a mock of `PersonaAgent`, because the point is to run the real
 * loop behind the real seam: a test that stubbed the loop would be checking that the
 * SDK returns what the test told it to.
 */
async function serveOnce(reply: string): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				choices: [{ message: { content: reply }, finish_reason: "stop" }],
				usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
			}),
		);
	});
	// Awaited, because `listen` is asynchronous and `address()` is null until it fires.
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	return {
		url: `http://127.0.0.1:${port}/v1`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-sdk-run-"));
	mkdirSync(join(dir, ".personaxis"), { recursive: true });
	personaPath = join(dir, ".personaxis", "personaxis.md");
	writeFileSync(personaPath, SPEC);
	saved = {
		home: process.env.PERSONAXIS_HOME,
		endpoint: process.env.PERSONAXIS_ENDPOINT,
		model: process.env.PERSONAXIS_MODEL,
	};
	process.env.PERSONAXIS_HOME = join(dir, "home");
});

afterEach(() => {
	for (const [key, value] of [
		["PERSONAXIS_HOME", saved.home],
		["PERSONAXIS_ENDPOINT", saved.endpoint],
		["PERSONAXIS_MODEL", saved.model],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

async function ran(reply: string, opts: Parameters<Persona["agentRun"]>[1] = {}) {
	const stub = await serveOnce(reply);
	process.env.PERSONAXIS_ENDPOINT = stub.url;
	process.env.PERSONAXIS_MODEL = "stub-1";
	try {
		const result = await new Persona(personaPath).agentRun("summarise the open TODOs", opts);
		if ("error" in result) throw new Error(`the run failed: ${result.error}`);
		return result;
	} finally {
		await stub.close();
	}
}

/** The entries one turn left, in order, with who wrote each. */
function written(turn: string): { type: string; author: Record<string, string> }[] {
	return readFileSync(join(dir, ".personaxis", "record.jsonl"), "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { body: Record<string, unknown>; author: Record<string, string> })
		.filter((entry) => entry.body.turn === turn)
		.map((entry) => ({ type: String(entry.body.type), author: entry.author }));
}

describe("what a caller gets back", () => {
	it("answers in the seam's vocabulary, not in one loop's shape", async () => {
		const { outcome } = await ran("there are three open TODOs");

		expect(outcome.answer).toBe("there are three open TODOs");
		expect(outcome.stopReason).toBe("answered");
		expect(outcome.steps).toBeGreaterThanOrEqual(1);
		expect(outcome.cost?.tokens).toBe(120);
	});

	it("names the turn, which the old shape had no way to do", async () => {
		// The one thing narrowing ADDED. A caller can take this id to the record and
		// read what was asked, what was answered, how it ended and what it cost.
		const { outcome } = await ran("done");

		expect(written(outcome.turn).map((e) => e.type)).toEqual([
			"turn-open",
			"message",
			"turn-close",
		]);
	});
});

describe("who the record says asked", () => {
	it("says a program did, when a program did", async () => {
		// It said `persona:self`, which is the persona asking itself, and the only other
		// option the seam offered was an unnamed human, which puts a person's hand on a
		// turn no person took. Both are false in the one field the record rests on.
		const { outcome } = await ran("done");
		const [opened] = written(outcome.turn);

		expect(opened!.author).toEqual({ kind: "component", name: "sdk" });
	});

	it("says who an embedder names, when it names one", async () => {
		// An embedder knows its own user and the record is where that belongs. It is never
		// inferred: nothing here guesses a person from an absent field.
		const { outcome } = await ran("done", { asker: { kind: "human", id: "david" } });
		const [opened] = written(outcome.turn);

		expect(opened!.author).toEqual({ kind: "human", id: "david" });
	});

	it("still credits the answer to the persona, whoever asked", async () => {
		// An answer credited to whoever asked for it is the forgery the author invariant
		// exists to prevent, and a caller-supplied asker is exactly where it would creep in.
		const { outcome } = await ran("done", { asker: { kind: "human", id: "david" } });
		const [, said] = written(outcome.turn);

		expect(said!.author).toEqual({ kind: "persona", id: "self" });
	});

	it("still carries the verification verdict, in the events", async () => {
		// Not lost with `AgentResult.verification`: every verifier is named on the bus,
		// with the quorum it had to clear. The persona above declares a gate, because a
		// spec with none runs none and a test against that would prove nothing.
		const { events } = await ran("done");
		const complete = events.find((e) => e.type === "verify-complete");
		const perVerifier = events.filter((e) => e.type === "verify-result");

		expect(complete).toBeDefined();
		expect(complete).toHaveProperty("passed");
		expect(complete).toHaveProperty("quorum");
		expect(perVerifier).toHaveLength(1);
		expect(perVerifier[0]).toHaveProperty("verifier", "says-something");
	});

	it("still carries the wall clock and the step budget, in the events", async () => {
		// Not lost with `AgentResult.budget.wallSeconds`.
		const { events } = await ran("done");
		const budget = events.find((e) => e.type === "agent-budget");

		expect(budget).toBeDefined();
		expect(budget).toHaveProperty("wallSeconds");
	});
});
