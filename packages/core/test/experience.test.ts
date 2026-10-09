/**
 * E117: the living loop observes the work and how it went, not only the request.
 *
 * Measured on 2026-09-23: after every turn the loop observed only the sentence the person typed, so
 * a persona that broke its delivery and one that delivered it evolved the same when told the same
 * words. The strongest check is the one the row asked for: same request, same persona, and the only
 * difference is what the runtime found in the work. The layers have to move apart.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	ensureState,
	extractEnvelopes,
	LivingLoop,
	loadPersona,
	readPreferences,
	run,
	writeState,
	type AppraisalSignal,
	type StateFile,
} from "../src/index.js";
import type { TurnOutcome } from "../src/run/vocabulary.js";

const FIX = `---
metadata: { name: t, version: 1.0.0 }
identity: { canonical_id: t }
improvement_policy: { mode: autonomous }
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-0.4, 0.4] }
---
body
`;

const outcome = (over: Partial<TurnOutcome>): TurnOutcome => ({ turn: "t1", stopReason: "answered", answer: "done", steps: 3, ...over });
const check = (passed: boolean, what: string) => ({ what, how: "ran the page", passed, scope: "targeted" as const, ...(passed ? {} : { reason: `${what} threw an error` }) });

describe("what a turn was like (E117)", () => {
	it("says nothing about a turn that touched nothing", () => {
		expect(run.experienceOf(outcome({}))).toBeUndefined();
	});

	it("says what the runtime found, in words the appraiser reads", () => {
		const ok = run.experienceOf(outcome({ delivered: { checks: [check(true, "game.html")], unverified: [] } }));
		expect(ok).toContain("works");
		const bad = run.experienceOf(outcome({ delivered: { checks: [check(false, "game.html"), check(true, "GAME.md")], unverified: [] } }));
		expect(bad).toContain("failed 1 of 2 checks");
		expect(bad).toContain("game.html threw an error");
	});

	it("names asking, refusals, what nobody could check, and a bad ending", () => {
		const text = run.experienceOf(
			outcome({
				stopReason: "budget",
				delivered: { checks: [], unverified: ["notes.md"] },
				calls: [
					{ callId: "a", tool: "ask_person", verdict: "allowed", step: 1 },
					{ callId: "b", tool: "write_file", verdict: "denied", step: 2 },
				],
			}),
		);
		expect(text).toContain("ran out of room");
		expect(text).toContain("stopped to ask");
		expect(text).toContain("refused 1 of its calls");
	});

	it("leaves out what nobody could check, which is the absence of a check and not an outcome", () => {
		// Measured with a real model on 2026-09-23: left in, "a document nobody could check" was the only
		// thing that ever moved a persona, always downward, and a document is never something the runtime
		// checks. It stays in the record (E85); it is not how the work went.
		const onlyUnchecked = run.experienceOf(outcome({ delivered: { checks: [], unverified: ["GAME.md"] } }));
		expect(onlyUnchecked).toBeUndefined();
		const withACheck = run.experienceOf(outcome({ delivered: { checks: [check(true, "game.html")], unverified: ["GAME.md"] } }));
		expect(withACheck).toContain("works");
		expect(withACheck).not.toContain("GAME.md");
	});
});

describe("a turn, lived through (E117)", () => {
	const recorder = (fail = false) => {
		const seen: Array<{ observation: string; source: string; actor?: string }> = [];
		return {
			seen,
			evolver: {
				observe: async (input: { observation: string; source: string; actor?: string }) => {
					seen.push({ observation: input.observation, source: input.source, actor: input.actor });
					if (fail) throw new Error("appraiser down");
					return { mutationsApplied: 0, memoriesWritten: 0, abstained: false };
				},
			},
		};
	};

	it("observes the request as a person's words and the experience as the runtime's facts", async () => {
		const { seen, evolver } = recorder();
		await run.livedThrough(evolver, { request: "make it", outcome: outcome({ delivered: { checks: [check(false, "game.html")], unverified: [] } }) });
		expect(seen.map((s) => s.source)).toEqual(["user", "internal"]);
		expect(seen[1]!.actor).toBe("runtime-context");
		expect(seen[1]!.observation).toContain("failed 1 of 1 checks");
	});

	it("spends no second appraisal on a turn with nothing to observe", async () => {
		const { seen, evolver } = recorder();
		await run.livedThrough(evolver, { request: "hello", outcome: outcome({}) });
		expect(seen).toHaveLength(1);
	});

	it("never throws, because nothing after the answer may cost the answer", async () => {
		const { seen, evolver } = recorder(true);
		await expect(
			run.livedThrough(evolver, { request: "x", outcome: outcome({ delivered: { checks: [check(true, "a")], unverified: [] } }) }),
		).resolves.toBeUndefined();
		// And a failed first observation does not stop the second one from being attempted.
		expect(seen).toHaveLength(2);
	});
});

describe("the runtime's report of a turn is nobody's preference (E117)", () => {
	// Found with a real model on 2026-09-23: the first measured turn wrote two preferences out of its
	// own experience report, while the commit that added the report said it could not.
	const WITH_PREFERENCES = FIX.replace("affect:", "memory:\n  types: { user_preferences: true }\naffect:");

	class Extractor {
		async appraise(): Promise<AppraisalSignal> {
			return { appraisal: "x", confidence: 0.9, mutations: [], memories: [], preferences: [{ key: "style", value: "terse", rationale: "read it somewhere" }] };
		}
	}

	const preferencesAfter = async (experience: boolean): Promise<Record<string, unknown>> => {
		const dir = mkdtempSync(join(tmpdir(), "pxs-pref-"));
		try {
			const personaPath = join(dir, "personaxis.md");
			writeFileSync(personaPath, WITH_PREFERENCES);
			ensureState(loadPersona(personaPath));
			const loop = new LivingLoop(personaPath, { appraiser: new Extractor() });
			await loop.tick({ observation: "What happened in the turn: 1 of 3 checks failed.", source: "internal", actor: "runtime-context", ...(experience ? { experience: true } : {}) });
			return readPreferences(personaPath);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it("writes no preference from an experience, and the same observation unmarked still would", async () => {
		expect(Object.keys(await preferencesAfter(true))).toEqual([]);
		// The control: the flag is what refuses, not the source or the appraiser.
		expect(Object.keys(await preferencesAfter(false))).toContain("style");
	});
});

describe("the same request, two outcomes, two directions (E117)", () => {
	// One persona per outcome, never one reset between them: the record IS the state here, so a
	// rewritten state.json is rebuilt from the record, and the first try at this test measured the
	// second outcome on top of the first.
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	const freshPersona = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "pxs-exp-"));
		dirs.push(dir);
		const personaPath = join(dir, "personaxis.md");
		writeFileSync(personaPath, FIX);
		const handle = loadPersona(personaPath);
		const values: Record<string, number> = {};
		for (const [field, envelope] of Object.entries(extractEnvelopes(handle.frontmatter).envelopes)) values[field] = envelope.mean;
		const state: StateFile = { schema_version: "0.6.0", persona_id: "t", persona_version: "1", values, mutation_log: [] };
		writeState(handle.statePath, state);
		return personaPath;
	};

	// What the appraiser is shown. Which way the layers move is the model's judgement (since 2026-10-07
	// there is no offline appraiser that counted words); what the runtime owes it is the work's outcome,
	// told apart, on the same request.
	const shown = async (turn: TurnOutcome): Promise<string[]> => {
		const personaPath = freshPersona();
		const seen: string[] = [];
		const appraiser = {
			appraise: async (input: { observation: string }): Promise<AppraisalSignal> => {
				seen.push(input.observation);
				return { appraisal: "", mutations: [], memories: [], confidence: 1 };
			},
		};
		const loop = new LivingLoop(personaPath, { appraiser });
		await loop.tick({ observation: "Build me a small game about a cat.", source: "user" });
		const experience = run.experienceOf(turn);
		if (experience) await loop.tick({ observation: experience, source: "internal", actor: "runtime-context" });
		return seen;
	};

	it("shows the appraiser how the work went, and the two outcomes read differently", async () => {
		const passed = await shown(outcome({ delivered: { checks: [check(true, "game.html")], unverified: [] } }));
		const failed = await shown(outcome({ delivered: { checks: [check(false, "game.html")], unverified: [] } }));
		const nothing = await shown(outcome({}));

		expect(passed).toHaveLength(2);
		expect(failed).toHaveLength(2);
		expect(passed[1]).not.toBe(failed[1]);
		expect(passed[1]).toMatch(/checked and it works/);
		expect(failed[1]).toMatch(/checked and failed 1 of 1/);
		// And a turn with nothing to observe shows only the request.
		expect(nothing).toHaveLength(1);
	});
});
