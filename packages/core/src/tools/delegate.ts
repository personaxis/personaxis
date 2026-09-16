/**
 * C6: handing a piece of work down, as a tool the model can reach.
 *
 * The rule this calls has been written since the study and called by nothing:
 * `run/delegation.ts` takes the photograph, keeps depth monotone, holds the child to
 * the parent's ledger and says out loud that a child does not ask. All of it correct,
 * all of it unreachable, which is the failure this repository keeps finding and the
 * reason a rule with no caller is worth less than no rule at all: it reads as done.
 *
 * ## The tool takes a task and nothing else
 *
 * No scope argument, and that is the decision. A model that could name the directories
 * its sub-task runs in would be a model deciding its own limits one indirection away,
 * and the whole point of the photograph is that the scope comes from what was declared
 * BEFORE the model was asked anything. A sub-task that needs something wider ends with
 * the limitation reported, which is what `scopeStatement` tells it in so many words.
 *
 * ## What it can DO, declared
 *
 * K6 asks a contributed tool what it can do rather than inferring it, and the honest
 * answer here is `spend`. Every other class a sub-task can reach, it reaches through
 * its own tools, each of which is gated on its own call and declares its own envelope;
 * delegation adds no authority to any of them, because the child inherits the parent's
 * explicit narrowing and nothing else. What delegation adds that no other tool
 * declares is a second agent's worth of tokens, on the same ledger.
 *
 * ## It refuses out loud, and never quietly
 *
 * Past the depth limit it returns a refusal the model can read, rather than throwing.
 * A throw here would end the parent's turn over a sub-task it could have worked
 * around, and the reference's own measured mistake was the opposite: a child blocked
 * in a way nothing could see.
 */

import type { CommandVerdict, Policy } from "../sandbox.js";
import { delegate, type DelegatedScope, type ExplicitScope } from "../run/delegation.js";
import { scopeStatement } from "../run/delegation.js";
import type { ToolSpec } from "./registry.js";

/**
 * How deep delegation may go before it is refused.
 *
 * Two, so a parent may hand work down and that child may hand a piece of its own
 * further, and there it stops. Three agents on one task is already a tree a person has
 * to hold in their head to review, and the failure this bounds is not depth itself but
 * spend: the ledger is shared, so a branch nobody asked about burns the budget of the
 * work somebody did ask about. Chosen to be cheap to reach, for the same reason the
 * chain limit next door is five and not five hundred: a limit that bites after the
 * bill is not a limit.
 */
export const MAX_DELEGATION_DEPTH = 2;

/**
 * The name the model calls it by.
 *
 * A constant because the loop reaches for this tool itself now (`E86`, a round of fresh context), and a loop
 * matching a bare string against a catalogue is a rename away from silently never finding it.
 */
export const DELEGATE_TOOL = "delegate";

/** What a sub-task produced, as the parent's tool needs to report it. */
export interface SubTaskResult {
	/** What it answered. Empty is a real outcome and says so rather than pretending. */
	readonly answer: string;
	/** How the sub-task's turn ended, in the runner's own vocabulary. */
	readonly stopReason: string;
	readonly steps: number;
}

/**
 * Runs one sub-task under a scope somebody else photographed.
 *
 * Injected, because building a run needs the persona, the model and the record, and a
 * tool that reached for those would be a tool that decides where work happens. It is
 * the same seam `ExecutionPort` is for the built-ins, for the same reason.
 */
export type SubTaskRunner = (task: {
	readonly instruction: string;
	readonly scope: DelegatedScope;
	/** The sentence the child is told about its own limits, ready to hand over. */
	readonly statement: string;
}) => Promise<SubTaskResult>;

export interface DelegateToolOptions {
	readonly run: SubTaskRunner;
	/**
	 * How deep the caller of this tool already is, read when the tool is CALLED.
	 *
	 * A function and not a number, because a session that resumes deeper than it
	 * started would otherwise hold a depth captured when the catalogue was built.
	 */
	readonly depth: () => number;
	/** What the calling persona narrowed for itself, read the same way and for the same reason. */
	readonly scope: () => ExplicitScope;
	readonly maxDepth?: number;
}

/** Delegating is not a file, a network or a destructive act; the sub-task's own calls are. */
const DELEGATION_CLASS = {
	writesFiles: false,
	network: false,
	destructive: false,
	escapesWorkspace: false,
} as const;

export function delegateTool(options: DelegateToolOptions): ToolSpec {
	return {
		name: "delegate",
		// `meta` and not a category of its own: it acts on the run rather than on a
		// file, a shell or a network, which is what the other five name. A seventh
		// category for one tool would be a subsetting rule nobody can use.
		category: "meta",
		description:
			"Hand one self-contained piece of this work to a sub-task and wait for its answer. " +
			"The sub-task runs under the limits you already have and cannot be given wider ones, " +
			"it cannot ask anybody for permission, and it spends from the same budget as you. " +
			"Use it to keep a long piece of work out of your own context, not to get access you lack.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["task"],
			properties: {
				task: {
					type: "string",
					description:
						"What the sub-task should do, complete enough to act on without asking you anything.",
				},
			},
		},
		isReadOnly: false,
		// Two sub-tasks at once would be two agents in one working directory editing
		// each other's files, which is the case `assign` refuses on a machine for the
		// same reason. The tree stays a line until something can say otherwise.
		isConcurrencySafe: false,
		// K6: see the note at the top. `spend` is what delegation adds that nothing
		// else declares; the rest is reached through the child's own gated tools.
		envelope: ["spend"],
		gate: (_args: Record<string, unknown>, _policy: Policy): CommandVerdict => ({
			decision: "allow",
			reason: "a sub-task under the caller's own scope; its calls are gated on their own",
			class: DELEGATION_CLASS,
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const instruction = typeof args.task === "string" ? args.task.trim() : "";
			if (!instruction) {
				// Refused rather than run: a sub-task with no instruction is an agent
				// doing something arbitrary, in a real directory, with real tools.
				return "refused: a sub-task needs an instruction, and this one was empty.";
			}

			const photograph = delegate({
				parentDepth: options.depth(),
				parentScope: options.scope(),
				maxDepth: options.maxDepth ?? MAX_DELEGATION_DEPTH,
			});

			if (!photograph.ok) return `refused: ${photograph.reason}. Do this part yourself.`;

			const result = await options.run({
				instruction,
				scope: photograph.scope,
				statement: scopeStatement(photograph.scope),
			});

			return describeSubTask(result);
		},
	};
}

/**
 * What comes back to the parent.
 *
 * The ending is named even when there is an answer, because "it finished" and "it ran
 * out of budget having said something" are different facts and the parent is about to
 * act on one of them. A sub-task that produced nothing says so plainly instead of
 * handing back an empty string the model reads as silence it should fill in.
 */
function describeSubTask(result: SubTaskResult): string {
	const answer = result.answer.trim();
	const ending =
		result.stopReason === "finished"
			? ""
			: `\n\n[the sub-task ended: ${result.stopReason}, after ${result.steps} step(s)]`;

	return answer
		? `${answer}${ending}`
		: `The sub-task produced no answer (${result.stopReason}, ${result.steps} step(s)).`;
}
