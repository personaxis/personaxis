/**
 * `update_tasks`: the persona writes its own task list, and only something done marks a step done.
 *
 * ## Why this exists
 *
 * E81. `task-state.ts` has held a goal, a plan and sub-tasks since J.6, survives compaction, and only the
 * loop wrote it: files touched and errors. The model had no way to say what was left and what was finished,
 * so a run of several steps kept its plan in the conversation, where it scrolls away. AgentFloor measured
 * that small open models fail exactly there, at long planning and sustained constraints, and
 * LongHorizon-Harness raised the same model's score by keeping the state outside the conversation and
 * letting it change only with facts from the environment.
 *
 * ## What it does
 *
 * The persona sends its whole list each time, which is the easiest thing to get right for a small model.
 * The loop handles the call, not the tool, because what makes a step done is a call that succeeded in this
 * run, and only the loop has seen those (`TaskStateTracker.replaceTasks`). A step marked done with nothing
 * behind it is kept as said done and shown as such, to the model and to the person. After every batch of
 * calls the list is put back at the end of what the model reads, so a long conversation does not lose it.
 *
 * It grants nothing, reads nothing and writes nothing outside the run's own state.
 */

import type { SubTaskStatus, TaskStateTracker } from "../task-state.js";
import { READ_CLASS } from "./gates.js";
import type { ToolSpec } from "./registry.js";

/** The name the loop special-cases. One owner, so a rename cannot half-happen. */
export const UPDATE_TASKS_TOOL = "update_tasks";

/** The words the model uses, and the state each one is. `in_progress` is the word models already know. */
const STATUSES: Readonly<Record<string, SubTaskStatus>> = {
	pending: "pending",
	in_progress: "active",
	done: "done",
	blocked: "blocked",
};

/**
 * The declaration the model is shown. Its `execute` is never reached: the loop intercepts by name, for the
 * reason `find_tools` gives, and the body says so rather than returning something plausible.
 */
export const updateTasksTool: ToolSpec = {
	name: UPDATE_TASKS_TOOL,
	category: "meta",
	description:
		"Write your task list for work with several steps: every step, each pending, in_progress, done or blocked. " +
		"Send the whole list each time and keep it current as you go. A step counts as done only when something you did backs it.",
	parameters: {
		type: "object",
		additionalProperties: false,
		required: ["tasks"],
		properties: {
			tasks: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["text", "status"],
					properties: {
						text: { type: "string", description: "The step, in a few words." },
						status: { type: "string", enum: Object.keys(STATUSES) },
					},
				},
			},
		},
	},
	isReadOnly: true,
	isConcurrencySafe: false,
	envelope: [],
	gate: () => ({ decision: "allow", reason: "the persona's own task list", class: READ_CLASS }),
	execute: async () => "error: update_tasks is handled by the loop, and this body should never run.",
};

/** What the loop does with one call: the list replaced, and what goes back to the model. */
export function applyTaskUpdate(
	tracker: TaskStateTracker,
	args: Record<string, unknown>,
	succeeded: readonly string[],
): { readonly ok: boolean; readonly reply: string } {
	if (!Array.isArray(args.tasks)) {
		return { ok: false, reply: "error: send the whole list as `tasks`, an array of { text, status }." };
	}
	const list: { text: string; status: SubTaskStatus }[] = [];
	const skipped: number[] = [];
	for (const [index, entry] of args.tasks.entries()) {
		const item = (entry ?? {}) as { text?: unknown; status?: unknown };
		const status = typeof item.status === "string" ? STATUSES[item.status] : undefined;
		if (typeof item.text !== "string" || !item.text.trim() || status === undefined) {
			skipped.push(index + 1);
			continue;
		}
		list.push({ text: item.text, status });
	}
	if (list.length === 0) {
		return { ok: false, reply: "error: no task had both a text and a status (pending, in_progress, done or blocked)." };
	}

	const unbacked = tracker.replaceTasks(list, succeeded);
	const lines = [tracker.renderTaskList()];
	if (skipped.length > 0) lines.push(`Left out task ${skipped.join(", ")}: each task needs a text and a status.`);
	if (unbacked.length > 0) {
		lines.push(
			`Marked done with nothing you did backing it: ${unbacked.map((task) => task.text).join("; ")}. Do the step, or keep it pending.`,
		);
	}
	return { ok: true, reply: lines.join("\n") };
}
