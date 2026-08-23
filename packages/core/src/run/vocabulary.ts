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

/** Why a turn ended. Closed, because an open set is a set nobody can switch on. */
export type StopReason =
	/** The model said it was done and produced an answer. */
	| "answered"
	/** A step budget ran out. The turn is closed with what it had. */
	| "budget"
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
	/** Present when the turn ended badly, with a code so it can be routed. */
	readonly failure?: { readonly code: string; readonly message: string };
}

/** What opens a turn. */
export interface TurnRequest {
	readonly turn: string;
	readonly prompt: string;
	/** Who asked. A turn nobody can attribute is a turn the record cannot describe. */
	readonly asker: { readonly kind: "human"; readonly id: string } | { readonly kind: "persona"; readonly id: string };
}

/**
 * Whether a stop reason means the turn produced an answer somebody is waiting on.
 *
 * Used to decide whether a close is a normal ending or one that owes an explanation.
 * `budget` is deliberately on the answering side: a turn that ran out of steps still
 * closes with whatever it had, and delivering that beats delivering nothing, which is
 * what the reference does with its final tool-free summarising call.
 */
export function answered(reason: StopReason): boolean {
	return reason === "answered" || reason === "budget";
}
