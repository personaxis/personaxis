/**
 * E86: when a long job opens a round of fresh context, and what that round is told.
 *
 * Both halves are pure on purpose. When a round opens is a decision about the run, and what a round is told is
 * the only thing that crosses into a context with no history: a test that could only see either through a
 * model would be a test of the model.
 */
import { describe, expect, it } from "vitest";

import { briefFor, MAX_ROUNDS_PER_TURN, nextRound, ROUND_LIST_FLOOR, roundsOn } from "../src/run/rounds.js";
import type { SubTask } from "../src/task-state.js";

const task = (id: string, status: SubTask["status"], extra: Partial<SubTask> = {}): SubTask => ({ id, text: `do ${id}`, status, ...extra });

/** A list of `n` things still to do, so the size signal can be moved without writing out twenty tasks. */
const waiting = (n: number): SubTask[] => Array.from({ length: n }, (_, i) => task(`t${i}`, "pending"));

const roomy = { contextPct: 0.1, contextThreshold: 0.8, rounded: new Set<string>(), taken: 0 };

describe("when a round opens (E86)", () => {
	it("does not open on a short list in a context with room, which is the ordinary turn", () => {
		expect(nextRound({ ...roomy, tasks: waiting(ROUND_LIST_FLOOR - 1) })).toBeUndefined();
	});

	it("opens on a list that has grown past what one context holds", () => {
		const opened = nextRound({ ...roomy, tasks: waiting(ROUND_LIST_FLOOR) });

		expect(opened?.because).toBe("list");
		expect(opened?.task.id).toBe("t0");
	});

	it("opens on a filling context, short list or not, before anything rewrites the transcript", () => {
		const opened = nextRound({ ...roomy, contextPct: 0.8, tasks: [task("a", "pending")] });

		expect(opened?.because).toBe("context");
	});

	it("takes the task the run is already on, rather than jumping the list", () => {
		// Jumping would leave the active one half done in a context about to be rewritten.
		const opened = nextRound({ ...roomy, contextPct: 0.9, tasks: [task("a", "pending"), task("b", "active")] });

		expect(opened?.task.id).toBe("b");
	});

	it("never hands the same task down twice", () => {
		// The parent cannot mark it done: only a call that succeeded HERE backs a done, and a round's calls
		// happened in the child. Without this the same task goes down for the rest of the turn.
		const opened = nextRound({ ...roomy, contextPct: 0.9, tasks: [task("a", "active"), task("b", "pending")], rounded: new Set(["a"]) });

		expect(opened?.task.id).toBe("b");
	});

	it("stops at the ceiling, because each round is a second agent on the same ledger", () => {
		expect(nextRound({ ...roomy, tasks: waiting(20), taken: MAX_ROUNDS_PER_TURN })).toBeUndefined();
	});

	it("does not open when there is nothing left to do, however full the context is", () => {
		expect(nextRound({ ...roomy, contextPct: 0.99, tasks: [task("a", "done"), task("b", "blocked")] })).toBeUndefined();
	});

	it("does not open for a run that keeps no list, because a round needs a task", () => {
		expect(nextRound({ ...roomy, contextPct: 0.99, tasks: [] })).toBeUndefined();
	});

	it("is off unless the settings ask for it", () => {
		expect(roundsOn({})).toBe(false);
		expect(roundsOn({ rounds: false })).toBe(false);
		expect(roundsOn({ rounds: true })).toBe(true);
	});
});

const brief = (over: Partial<Parameters<typeof briefFor>[0]> = {}) =>
	briefFor({
		goal: "build the arcade game",
		task: task("b", "active"),
		tasks: [task("b", "active")],
		delivered: { checks: [], unverified: [] },
		errors: [],
		...over,
	});

describe("what a round is told (E86)", () => {
	it("carries the job and the one task it is for", () => {
		const text = brief();

		expect(text).toContain("build the arcade game");
		expect(text).toContain("Your task, and the only one: do b");
	});

	it("keeps the rest of the list out, so a fresh context does not do somebody else's steps", () => {
		const text = brief({ tasks: [task("b", "active"), task("c", "pending"), task("d", "pending")] });

		expect(text).not.toContain("do c");
		expect(text).not.toContain("do d");
	});

	it("carries a finished step as finished only where something done backs it", () => {
		const text = brief({ tasks: [task("a", "done", { verified: true }), task("b", "active")] });

		expect(text).toContain("[x] do a");
	});

	it("carries a step said done that nothing backs in those words, and never as done", () => {
		// `E81`'s own sentence, so the line a person reads on screen is the line a round reads.
		const text = brief({ tasks: [task("a", "done", { verified: false }), task("b", "active")] });

		expect(text).toContain("[?] do a");
		expect(text).toContain("said done; nothing done backs it yet");
	});

	it("says what was left and what running it proved, failure and reason included", () => {
		const text = brief({
			delivered: {
				checks: [
					{ what: "/w/game.html", how: "ran it for 10 seconds of frames", passed: false, reason: "missing is not defined", scope: "targeted" },
					{ what: "/w/data.json", how: "parsed it as JSON", passed: true, scope: "targeted" },
				],
				unverified: [],
			},
		});

		expect(text).toContain("/w/game.html: ran it for 10 seconds of frames, and it FAILED: missing is not defined");
		expect(text).toContain("/w/data.json: parsed it as JSON, and it worked");
	});

	it("names what nothing could check, because an absence nobody names reads as verified", () => {
		const text = brief({ delivered: { checks: [], unverified: ["/w/GAME.md"] } });

		expect(text).toContain("/w/GAME.md: left, and nothing here could check it automatically");
	});

	it("says plainly that nothing has been left yet, rather than leaving the section out", () => {
		expect(brief()).toContain("What has been left on disk so far, and what running it proved:\n  nothing yet");
	});

	it("carries what the tools said went wrong, which is the environment talking and not the model", () => {
		expect(brief({ errors: ["write_file: error: outside the workspace"] })).toContain("write_file: error: outside the workspace");
	});

	it("tells the round it cannot ask anybody, and what to do instead of inventing", () => {
		// E84 crossing the boundary: a sub-task has no way to reach a person and every approval is refused.
		const text = brief();

		expect(text).toContain("Nobody can be asked anything from here");
		expect(text).toContain("instead of inventing it");
	});

	it("asks for what it left and what it checked, which is all that goes back", () => {
		expect(brief()).toContain("Answer with what you left and what you checked about it");
	});
});
