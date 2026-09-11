// What a service does next, case by case.
//
// Every failure mode of this function is silent: a service that runs a step
// twice, one that stops halfway, one that skips an approval. None of them
// throws, none of them logs, and all of them look like "it just did that". So
// the cases are enumerated rather than sampled.

import { describe, expect, it } from "vitest";

import { advance, approved, begin, rejected, retry, type StepShape } from "../../src/service/advance.js";

const step = (position: number, requiresApproval = false): StepShape => ({
	position,
	requiresApproval,
});

const running = (currentPosition: number) => ({ status: "running", currentPosition });
const waiting = (currentPosition: number) => ({ status: "waiting", currentPosition });

const THREE = [step(1), step(2), step(3)];

describe("starting a service", () => {
	it("starts at the first step", () => {
		expect(begin(THREE)).toEqual({ kind: "start", position: 1 });
	});

	it("starts at the lowest position, whatever order the rows arrive in", () => {
		// Rows come back in whatever order the planner chose. A function that took
		// the first element would work in every test and run steps out of order
		// the first time a query changed.
		expect(begin([step(3), step(1), step(2)])).toEqual({ kind: "start", position: 1 });
	});

	it("refuses a service with no steps, at the moment somebody presses start", () => {
		// Here rather than in a continuation that finds nothing later, because
		// this is where a person is looking.
		expect(begin([])).toMatchObject({ kind: "fail" });
	});
});

describe("a step finishing", () => {
	it("moves to the next one", () => {
		expect(advance(running(1), THREE, "completed")).toEqual({ kind: "start", position: 2 });
		expect(advance(running(2), THREE, "completed")).toEqual({ kind: "start", position: 3 });
	});

	it("completes the run after the last one", () => {
		expect(advance(running(3), THREE, "completed")).toEqual({ kind: "complete", reason: null });
	});

	it("skips a gap in the positions rather than stalling on it", () => {
		// Positions should be contiguous, and a delete that left a hole must not
		// leave a run stuck looking for a step that is not there.
		expect(advance(running(1), [step(1), step(5)], "completed")).toEqual({
			kind: "start",
			position: 5,
		});
	});
});

describe("a step that ends badly", () => {
	it("fails the run and stays on the step that failed", () => {
		// Staying is what makes "retry from here" a continuation of this run.
		const decision = advance(running(2), THREE, "failed");
		expect(decision).toMatchObject({ kind: "fail" });
		expect(decision).toMatchObject({ reason: "step 2 failed" });
	});

	it("treats a deliberate stop as a completed delivery, not a failure", () => {
		// The Watcher looked at yesterday and there was nothing worth writing
		// about. That is a complete delivery of nothing, and calling it a failure
		// would put a red mark on a service working exactly as intended.
		expect(advance(running(1), THREE, "stopped")).toMatchObject({ kind: "complete" });
	});

	it("does not silently skip a step somebody deleted mid-run", () => {
		// Moving to "the next one after a position that no longer exists" is a
		// service quietly dropping work that was removed on purpose.
		expect(advance(running(2), [step(1), step(3)], "completed")).toMatchObject({
			kind: "fail",
		});
	});
});

describe("approval", () => {
	it("waits after the step that asks for it", () => {
		expect(advance(running(1), [step(1, true), step(2)], "completed")).toEqual({
			kind: "wait",
			afterPosition: 1,
		});
	});

	it("waits after the LAST step too, because that is the sign-off on the delivery", () => {
		// The bug this pins: checking "is there a next step" before checking
		// approval skips the final sign-off exactly when the whole delivery is
		// what is being signed off.
		expect(advance(running(2), [step(1), step(2, true)], "completed")).toEqual({
			kind: "wait",
			afterPosition: 2,
		});
	});

	it("continues to the next step when a person approves", () => {
		expect(approved(waiting(1), THREE)).toEqual({ kind: "start", position: 2 });
	});

	it("completes when the approval was on the last step", () => {
		expect(approved(waiting(3), THREE)).toEqual({ kind: "complete", reason: null });
	});

	it("ends the run as complete, not failed, when a person says no", () => {
		// Somebody deciding not to send the email is the system working. A red
		// run would teach people that using the approval is a failure.
		expect(rejected(waiting(2), "the numbers are wrong")).toEqual({
			kind: "complete",
			reason: "the numbers are wrong",
		});
	});

	it("ignores an approval for a run that is not waiting", () => {
		expect(approved(running(1), THREE)).toMatchObject({ kind: "none" });
		expect(rejected(running(1), null)).toMatchObject({ kind: "none" });
	});
});

describe("retrying", () => {
	it("restarts the step that failed, in the same run", () => {
		// Not a new run. A retry that started one would turn the record from what
		// happened into what eventually worked.
		expect(retry({ status: "failed", currentPosition: 2 }, THREE)).toEqual({
			kind: "start",
			position: 2,
		});
	});

	it("refuses to retry a run that did not fail", () => {
		expect(retry({ status: "completed", currentPosition: 3 }, THREE)).toMatchObject({
			kind: "none",
		});
		expect(retry(running(1), THREE)).toMatchObject({ kind: "none" });
	});

	it("refuses when the step it failed on is gone", () => {
		expect(retry({ status: "failed", currentPosition: 2 }, [step(1)])).toMatchObject({
			kind: "fail",
		});
	});
});

describe("events that arrive late", () => {
	it("does nothing for a run that already ended", () => {
		// A reconnect replays. Acting on it would restart a delivery somebody
		// watched finish, on a real machine, in a real folder.
		for (const status of ["completed", "failed", "stopped", "waiting"]) {
			expect(advance({ status, currentPosition: 1 }, THREE, "completed")).toMatchObject({
				kind: "none",
			});
		}
	});
});
