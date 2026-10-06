/**
 * What a service does next, once a step has finished.
 *
 * The heart of a service, and deliberately a pure function of three things: the
 * run, its steps, and how the step that just ended went. No database, no clock,
 * no network. Everything that decides whether a delivery continues, waits for a
 * person or stops is here and is readable in one screen, because the failure
 * modes of this function are a service that runs a step twice and a service that
 * silently stops halfway, and neither announces itself.
 *
 * ## The line is straight, and stopping is the only fork
 *
 * Steps run 1, 2, 3. There are no branches and no loops in v1. What a step CAN
 * do is end the whole service early, which is the case that looks like a failure
 * and is not: the Watcher looks at yesterday's diffs, finds nothing worth
 * writing about, and says so. Without somewhere to put that, "finished after one
 * of three steps" reads as something broken.
 *
 * ## Approval sits between two steps, not on one
 *
 * `requiresApproval` on a step means: when this step is done, a person says yes
 * before the next one starts. On the producing step rather than the consuming
 * one, because what somebody approves is an outcome they can read, and the step
 * that produced it is the one whose name is on it.
 *
 * The last step's approval is not a gate on nothing: it is the sign-off on the
 * delivery itself, so the run waits and completes when the person says yes.
 *
 * ## A failed step stops the service, and stays where it failed
 *
 * It does not skip ahead and it does not start over. `currentPosition` stays on
 * the step that failed, which is what makes "retry from here" a continuation of
 * this run rather than a new one. A retry that started a fresh run would turn
 * the record from what happened into what eventually worked.
 */

export type StepOutcome = "completed" | "failed" | "stopped";

export interface RunState {
	status: string;
	currentPosition: number;
}

export interface StepShape {
	position: number;
	requiresApproval: boolean;
}

export type Advance =
	/** Start the step at this position. */
	| { kind: "start"; position: number }
	/** Somebody owes an answer before the step at `position` may start. */
	| { kind: "wait"; afterPosition: number }
	| { kind: "complete"; reason: string | null }
	| { kind: "fail"; reason: string | null }
	/** Nothing to do: the run is already over, or the message is stale. */
	| { kind: "none"; why: string };

/**
 * The first thing a run does.
 *
 * Separate from `advance` because "begin" and "continue" are different
 * questions, and a service with no steps has to be refused HERE, at the moment
 * somebody presses start, rather than by a continuation that finds nothing.
 */
export function begin(steps: readonly StepShape[]): Advance {
	const first = ordered(steps)[0];
	if (!first) {
		return { kind: "fail", reason: "this service has no steps, so there is nothing to run" };
	}
	return { kind: "start", position: first.position };
}

export function advance(run: RunState, steps: readonly StepShape[], outcome: StepOutcome): Advance {
	if (run.status !== "running") {
		// A late event for a run that already ended, which a reconnect produces.
		// Acting on it would restart a delivery somebody watched finish.
		return { kind: "none", why: `this run is ${run.status}` };
	}

	const line = ordered(steps);
	const current = line.find((step) => step.position === run.currentPosition);
	if (!current) {
		// The step was deleted while the run was on it. Refusing to guess: moving
		// to "the next one after a position that no longer exists" is a service
		// silently skipping work somebody removed on purpose.
		return {
			kind: "fail",
			reason: `step ${run.currentPosition} is no longer part of this service, so the run cannot continue`,
		};
	}

	if (outcome === "failed") {
		return { kind: "fail", reason: `step ${current.position} failed` };
	}

	if (outcome === "stopped") {
		// The deliberate early end. Not a failure: a step decided there was
		// nothing to do, and that is a complete delivery of nothing.
		return { kind: "complete", reason: `stopped at step ${current.position}` };
	}

	if (current.requiresApproval) {
		// Waiting comes before "is there a next one", so the final step's approval
		// is honoured. Otherwise the last step's sign-off would be skipped exactly
		// when the whole delivery is what is being signed off.
		return { kind: "wait", afterPosition: current.position };
	}

	return next(line, current.position);
}

/**
 * What happens when a person approves the step the run is waiting on.
 *
 * Its own entry point rather than a flag on `advance`, because approving is not
 * an outcome of a step: the step already ended. The run is `waiting`, which is a
 * different state from `running`, and this is the only thing that leaves it.
 */
export function approved(run: RunState, steps: readonly StepShape[]): Advance {
	if (run.status !== "waiting") return { kind: "none", why: `this run is ${run.status}` };
	return next(ordered(steps), run.currentPosition);
}

/** A person refusing. The run ends, and it ends as stopped rather than failed. */
export function rejected(run: RunState, reason: string | null): Advance {
	if (run.status !== "waiting") return { kind: "none", why: `this run is ${run.status}` };
	return { kind: "complete", reason: reason ?? `not approved at step ${run.currentPosition}` };
}

/**
 * Retrying the step that failed.
 *
 * Continues this run rather than starting another, which is the decision the
 * whole record rests on. Only from a failed run, and only on the position it
 * failed at: a retry of a completed run is a new delivery and should be started
 * as one.
 */
export function retry(run: RunState, steps: readonly StepShape[]): Advance {
	if (run.status !== "failed") {
		return { kind: "none", why: `only a failed run is retried, and this one is ${run.status}` };
	}
	const exists = steps.some((step) => step.position === run.currentPosition);
	if (!exists) {
		return {
			kind: "fail",
			reason: `step ${run.currentPosition} is no longer part of this service`,
		};
	}
	return { kind: "start", position: run.currentPosition };
}

function next(line: readonly StepShape[], from: number): Advance {
	const following = line.find((step) => step.position > from);
	if (!following) return { kind: "complete", reason: null };
	return { kind: "start", position: following.position };
}

/**
 * Sorted by position, and by position only.
 *
 * The rows arrive from a database whose order is whatever the planner chose. A
 * function that decided what runs next from an unordered list would work in
 * every test and run steps out of order the first time a query changed.
 */
function ordered(steps: readonly StepShape[]): StepShape[] {
	return [...steps].sort((a, b) => a.position - b.position);
}
