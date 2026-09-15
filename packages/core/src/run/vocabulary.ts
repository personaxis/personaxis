/**
 * Turns and steps, and the closed set of ways a turn can end.
 *
 * Three levels, kept apart because conflating them is how a runtime ends up with three
 * counters that mean different things and one number that means none of them.
 *
 *   A **turn** is what a request from the person opens and an answer closes.
 *   A **step** is one request to the model plus whatever tools it called.
 *   An **attempt** is one try at a step, retried after a rate limit or a refresh.
 *
 * The reference runtime keeps all three and says so; what it does not have is a single
 * place where a turn ends. Its own contract says a delivered answer must close the
 * durable turn, and twenty-five early returns skip the function that does it. The
 * contract is right and the enforcement is a convention, which is the shape of a rule
 * that holds until somebody is in a hurry.
 *
 * ## The turn exists to answer
 *
 * That sentence decides more than it looks like. It came out of the study twice
 * independently: a memory write retrying inside a turn until the budget was gone and
 * the person got no reply, and an empty-response guard that trims retries instead of
 * blocking. Both say the same thing, so it is written here once as a rule of the
 * vocabulary: **no accessory operation may spend the turn's budget**, because the turn
 * exists to answer and everything else is in service of that.
 */

/**
 * Why a turn ended. Closed, because an open set is a set nobody can switch on.
 *
 * `answered` means the loop said it was DONE, and nothing else does. That was not true
 * until it was measured: a loop that ran out of steps and a loop that called `finish`
 * both came back `answered`, so "did this turn complete the task" had no answer in the
 * vocabulary at all. It only surfaced when the SDK went to narrow its return to this,
 * because `AgentResult.finished` is the field that would have been lost.
 */
export type StopReason =
	/** The loop said it was done. Not merely that a person got something back. */
	| "answered"
	/** There was no room: a step, token, cost or time ceiling. Closed with what it had. */
	| "budget"
	/**
	 * It stopped early on a condition somebody declared, closing with what it had.
	 *
	 * Separate from `budget` because a ceiling and a rule are different things. An
	 * operator who wrote `stop_conditions: [no_progress]` asked for this, and calling
	 * it a budget would report their rule working as their budget running out.
	 */
	| "stopped"
	/** A guard refused something the turn could not continue without. */
	| "refused"
	/** The person interrupted. */
	| "interrupted"
	/** The model produced nothing usable after its retries. */
	| "empty"
	/** Something failed in a way the turn could not carry on through. */
	| "failed"
	/** The provider returned without closing, so the runtime closed it. */
	| "abandoned";

import type { CompactionPlan } from "../compaction/service.js";
import type { RecordBody } from "../record/entry.js";
import type { DelegatedScope } from "./delegation.js";

/**
 * One compaction, on its way from the loop to the record.
 *
 * E25. It travels through the seam rather than being written where it happened,
 * because the loop does not write the record: the runner tells the record and the
 * record holds facts about the persona, and a loop that wrote its own entries would be
 * deciding both what happened and what is remembered about it.
 *
 * `why` is the reason as the author will carry it, not a description composed later.
 * `compactionAuthor` puts it on the entry and `compactionEntry` puts it in the message,
 * so a reader is told what triggered the compaction by the same words twice rather than
 * by two accounts that can drift.
 */
export interface TurnCompaction {
	readonly why: string;
	readonly plan: CompactionPlan;
	/**
	 * E80: the step it was taken before, when the provider counts steps. What lets the record put a
	 * compaction and the calls of the same turn in the order they happened.
	 */
	readonly step?: number;
}

/**
 * One call that reached the gate, on its way from the loop to the record.
 *
 * E80. Travels through the seam for the reason `TurnCompaction` does: the loop does not write the
 * record. What the gate decided, and what of the persona's own material the call used, are both
 * facts the loop saw and the record keeps.
 */
export interface TurnCall {
	readonly callId: string;
	readonly tool: string;
	readonly verdict: "allowed" | "denied";
	/** Why it was refused, or that it was allowed only after asking. */
	readonly reason?: string;
	/** The skill it loaded or the reference, example or asset it read. The record's shape, not a second one. */
	readonly used?: NonNullable<Extract<RecordBody, { readonly type: "call" }>["used"]>;
	/** The step it was made in, so it lands after a compaction taken before that step. */
	readonly step: number;
}

/** What a turn produced. */
export interface TurnOutcome {
	readonly turn: string;
	readonly stopReason: StopReason;
	/** What the person is shown. Empty when the turn produced nothing. */
	readonly answer: string;
	/** Steps taken, for the record and for the budget. */
	readonly steps: number;
	/**
	 * What the turn cost, when whoever ran it can say.
	 *
	 * Optional, and the option is the point rather than convenience. Every provider
	 * takes steps and the runtime counts those itself; only a provider talking to
	 * something that charges can report tokens and money, and a scripted one cannot.
	 * Requiring it would make every test provider claim its turns were free, which is
	 * a different statement from having no price to give.
	 *
	 * It is here rather than left to a counter beside the runner because a total kept
	 * elsewhere is a number that can disagree with the turns it claims to add up.
	 */
	readonly cost?: { readonly tokens: number; readonly usd: number };
	/** Present when the turn ended badly, with a code so it can be routed. */
	readonly failure?: { readonly code: string; readonly message: string };
	/**
	 * E25: every compaction this turn did, for the record to write down.
	 *
	 * Optional for the same reason `cost` is, and the reason is worth keeping straight.
	 * A provider that does not manage a context window has no compactions to report,
	 * which is not the same statement as a provider that managed one and compacted
	 * nothing. Absent is silence; an empty array is a provider saying it looked.
	 */
	readonly compactions?: readonly TurnCompaction[];
	/**
	 * E80: every call the gate judged this turn, in order, for the record to write down.
	 *
	 * Optional for the reason `compactions` is. A provider that runs no tools through our gate has none
	 * to report, which is a different statement from a loop that looked and made none.
	 */
	readonly calls?: readonly TurnCall[];
	/**
	 * E81: the persona's task list as the turn left it, when it kept one.
	 *
	 * Absent when it kept none, which is the ordinary case for a question answered in one step, and there is
	 * nothing to write down about a list that never existed.
	 */
	readonly tasks?: Extract<RecordBody, { readonly type: "tasks" }>["tasks"];
	/**
	 * E83: the route the persona chose before acting, when its model's scaffold took the decision step and the
	 * reply could be read. Absent otherwise, and absent is not "answer": no step means nobody decided.
	 */
	readonly decision?: {
		readonly route: Extract<RecordBody, { readonly type: "decision" }>["route"];
		readonly why: string;
	};
}

/** What opens a turn. */
export interface TurnRequest {
	readonly turn: string;
	readonly prompt: string;
	/**
	 * Who asked. A turn nobody can attribute is a turn the record cannot describe.
	 *
	 * Three kinds, because three things ask. A person types. A persona delegates. And a
	 * PROGRAM drives, which is what an embedded SDK or an HTTP call is, and which used
	 * to have to pick one of the other two: `human` puts a person's hand on a turn no
	 * person took, and `persona` says the persona asked itself. Both are false in the
	 * one field the whole record rests on being true.
	 */
	readonly asker:
		| { readonly kind: "human"; readonly id: string }
		| { readonly kind: "persona"; readonly id: string }
		| { readonly kind: "component"; readonly name: string };
	/**
	 * The scope this turn was handed, when it is a delegated sub-task.
	 *
	 * It travels WITH the request rather than being set on the runner, because it is a
	 * property of this turn and not of the session: the same runner shape serves a
	 * person's turn and a sub-task's, and a field on the session would be a limit that
	 * outlives the work it was taken for.
	 *
	 * Absent on every turn a person or a program asks for, which is what makes its
	 * presence mean something in the record.
	 */
	readonly delegation?: DelegatedScope;
}

/**
 * Whether a stop reason means the turn produced an answer somebody is waiting on.
 *
 * Used to decide whether a close is a normal ending or one that owes an explanation.
 * `budget` and `stopped` are deliberately on the answering side: a turn that ran out of
 * room still closes with whatever it had, and delivering that beats delivering nothing,
 * which is what the reference does with its final tool-free summarising call.
 *
 * It is NOT the question "did the loop finish the task". That is `stopReason ===
 * "answered"` and nothing else, and conflating the two is what let a turn that ran out
 * of steps report itself complete.
 */
export function answered(reason: StopReason): boolean {
	return reason === "answered" || reason === "budget" || reason === "stopped";
}
