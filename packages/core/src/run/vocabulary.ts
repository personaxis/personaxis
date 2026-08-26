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
