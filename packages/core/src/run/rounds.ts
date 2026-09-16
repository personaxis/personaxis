/**
 * E86: a long job in rounds of fresh context, with the state outside.
 *
 * ## Why this exists
 *
 * A long task degrades the context it runs in, and the errors accumulate in it. The LongHorizon-Harness
 * summary measured the separation that fixes it: one part carries the state, another executes with a clean
 * context, a third audits. The state is already outside (`task-state.ts`, held apart from the transcript so a
 * compaction cannot lose it) and the audit is already there (`E85`, the turn checks what it left). What was
 * missing is the middle one: a task that runs somewhere the parent's transcript never reached.
 *
 * ## What a round is, and what it is not
 *
 * A round is ONE task of the list handed to a sub-task of the same persona, with a brief this module writes
 * from the state. It runs over the delegation that already exists, so the scope photograph, the monotone
 * depth, the shared ledger, the approval that is refused with its reason (`C6b`) and the "only the summary
 * comes back" (`describeSubTask`) are the ones already proven, and nothing here re-implements any of them.
 *
 * It is not a planner and it does not decide anything about the work. It decides WHEN the context is a bad
 * place to keep working, and WHAT a fresh one needs to be told.
 *
 * ## The brief carries facts, and the difference is the whole point
 *
 * A fresh round that started from the parent's account of itself would inherit exactly what degraded. So what
 * crosses the boundary is what the environment says: the goal somebody asked for, the one task, the steps
 * something done backs (`E81`), the deliverables with the result of the check that follows from each one
 * (`E85`), and the errors tools returned. A step said done that nothing backs crosses in those words and
 * never as done.
 *
 * `plan` and `decisions` of the state do not cross, and that is measured rather than judged: on 2026-09-16
 * `setPlan` and `recordDecision` have no caller anywhere in `core` or the CLI, so both are always empty, and
 * an empty "Decisions:" heading in a brief teaches a model there were none.
 */

import { lineFor, type SubTask } from "../task-state.js";
import type { DerivedResult } from "./derived-checks.js";

/** Why a round opened. Two signals, both of them already measured by the loop. */
export type RoundTrigger = "list" | "context";

/**
 * How many tasks still to do make a job that does not fit in one context.
 *
 * Six, and the reason is the shape of the failure rather than the number. Rounds exist for work one head
 * cannot hold; a job of five steps is work one head holds, and rounding it would buy a second agent per step
 * for nothing. The list is capped at twenty (`DEFAULT_LIMITS.maxSubTasks`), so a floor near that cap would
 * only ever fire on a list already being truncated.
 */
const ROUND_LIST_FLOOR = 6;

/**
 * How many rounds one turn may open.
 *
 * Each round is a second agent's worth of tokens on the same ledger, which is the one thing delegation
 * declares it adds (`envelope: ["spend"]`). The delegation depth limit is two for the same reason and says
 * it plainly: a limit that bites after the bill is not a limit.
 */
export const MAX_ROUNDS_PER_TURN = 4;

/**
 * How much of a round's answer the record keeps.
 *
 * The whole answer goes into the parent's context, because that is what the parent has to work from. The
 * record keeps the opening of it: enough to read what the round said it did, without the record becoming a
 * second copy of every sub-task's prose.
 */
export const ROUND_REPLY_CHARS = 400;

/** One round, as the turn reports it and the record writes it down. */
export interface RoundTaken {
	/** The task it was given, in the persona's own words. */
	readonly task: string;
	readonly because: RoundTrigger;
	/** What came back to the parent, which is the sub-task's summary and never its transcript. */
	readonly reply: string;
}

/** The task a round would take, and why now. */
export interface RoundOpening {
	/**
	 * The listed task this round takes.
	 *
	 * Absent when the persona kept no list and the context filled anyway, which is not a corner case: measured
	 * on 2026-09-16, neither model wrote a list on a six piece job, in any of eight runs.
	 */
	readonly task?: SubTask;
	readonly because: RoundTrigger;
}

/**
 * Whether this model was asked to work in rounds.
 *
 * Off unless the settings say otherwise, which is `plan`'s rule and for `plan`'s reason: "the agent now hands
 * its own work down" is a change an operator chooses rather than discovers. Read off the model settings like
 * `scaffoldFor` reads the scaffold, so the same declaration an operator already knows how to write switches
 * it on, and a bench can measure the same build with it and without it.
 */
export function roundsOn(llm: { readonly rounds?: boolean }): boolean {
	return llm.rounds === true;
}

/**
 * The task the next round should take, or nothing.
 *
 * A round needs a task to hand down, and the list is the only place a task comes from: a run whose persona
 * keeps no list never rounds, and compaction goes on doing what it did. A task gets at most one round, because
 * the parent cannot mark it done (only a call that succeeded in the PARENT's run backs a done, and a round's
 * calls happened in the child), so without that rule the same task would be handed down forever.
 */
export function nextRound(state: {
	readonly tasks: readonly SubTask[];
	readonly contextPct: number;
	readonly contextThreshold: number;
	readonly rounded: ReadonlySet<string>;
	readonly taken: number;
}): RoundOpening | undefined {
	if (state.taken >= MAX_ROUNDS_PER_TURN) return undefined;

	const left = state.tasks.filter((task) => task.status === "pending" || task.status === "active");
	const full = state.contextPct >= state.contextThreshold;
	const because: RoundTrigger | undefined = left.length >= ROUND_LIST_FLOOR ? "list" : full ? "context" : undefined;
	if (because === undefined) return undefined;

	// The one being worked on, and failing that the next one waiting. A round takes the task the run is
	// already on rather than jumping the list, which would leave the active one half done in a context about
	// to be rewritten.
	const task = left.find((t) => t.status === "active" && !state.rounded.has(t.id)) ?? left.find((t) => !state.rounded.has(t.id));
	if (task !== undefined) return { task, because };

	// No listed task, and the context is full anyway. This branch exists because of a measurement rather than
	// a guess: on 2026-09-16, across the eight runs of `e86base` and `e86rounds`, neither model wrote a list on
	// a job of six pieces, with `update_tasks` offered in every catalogue. A context signal that needed a
	// listed task could therefore never fire, which made one of the two signals this row names decorative.
	//
	// So what goes down is what is LEFT of the job, and the per-turn ceiling is what bounds it rather than the
	// one-round-per-task rule, which has no task to key on. A second one is not a repeat of the first: the
	// deliverables and their checks have moved underneath it, so its brief is about a different state.
	//
	// Only with NO LIST AT ALL. A list that exists takes neither branch once it has nothing to give: whether
	// its tasks are all done, all blocked, or all already handed down, the list is the persona's own account of
	// what is left, and handing down "the rest" on top of it would be work it says is finished, or work that
	// has been done once already. Written this way because the first version fired on an empty `left` and an
	// existing test caught it: a list saying "nothing pending" is not the same fact as no list.
	return full && state.tasks.length === 0 ? { because: "context" } : undefined;
}

/** What running each deliverable proved, in the words the check itself used. */
function whatWasLeft(delivered: DerivedResult): string[] {
	const lines = delivered.checks.map((check) =>
		check.passed
			? `  - ${check.what}: ${check.how}, and it worked`
			: `  - ${check.what}: ${check.how}, and it FAILED${check.reason ? `: ${check.reason}` : ""}`,
	);
	// Named one by one, because an absence nobody names reads as verified, and a fresh context has no other
	// way to tell "checked and fine" from "nobody could check it".
	for (const path of delivered.unverified) lines.push(`  - ${path}: left, and nothing here could check it automatically`);
	return lines;
}

/**
 * The brief a round starts with.
 *
 * Written by the runtime and never by the model, which is what makes it a fact rather than a summary. The
 * order is deliberate: what the job is, the one thing to do, what is already true, and only then how to work.
 */
export function briefFor(input: {
	readonly goal: string;
	/** The listed task this round takes. Absent when there is no list, and then the round finishes what is left. */
	readonly task?: SubTask;
	readonly tasks: readonly SubTask[];
	readonly delivered: DerivedResult;
	readonly errors: readonly string[];
}): string {
	const out: string[] = [
		input.task === undefined
			? "You are picking up a job part way through, in a context that has none of its history."
			: "You are doing one task of a longer job, in a context that has none of its history.",
	];

	if (input.goal.trim()) out.push("", `The job: ${input.goal.trim()}`);
	out.push("", input.task === undefined ? "Your task: finish what this job still needs." : `Your task, and the only one: ${input.task.text}`);

	// `E81`'s own words for a step said done that nothing backs, so the same sentence a person reads on screen
	// is the one a round reads. A round that took "done" at face value would build on a claim.
	const done = input.tasks.filter((task) => task.status === "done");
	out.push("", "What is already finished in this job:");
	if (done.length === 0) out.push("  nothing yet");
	else for (const task of done) out.push(`  ${lineFor(task)}`);

	const left = whatWasLeft(input.delivered);
	out.push("", "What has been left on disk so far, and what running it proved:");
	if (left.length === 0) out.push("  nothing yet");
	else out.push(...left);

	if (input.errors.length > 0) {
		out.push("", "What went wrong recently, as the tools reported it:");
		for (const error of input.errors) out.push(`  - ${error}`);
	}

	out.push(
		"",
		(input.task === undefined
			? "How to work here: finish what the job still needs, and nothing beyond it. "
			: "How to work here: do this task and nothing else, because the rest of the list belongs to whoever picks it up next. ") +
			"Nobody can be asked anything from here: there is no person at this keyboard and anything needing approval is refused, " +
			"so if this task needs something only a person has, stop and say exactly what is missing instead of inventing it. " +
			"Answer with what you left and what you checked about it, in a few lines: that answer is all that goes back.",
	);

	return out.join("\n");
}
