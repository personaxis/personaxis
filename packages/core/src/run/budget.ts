/**
 * A budget the delegation tree shares, charged when the work happened.
 *
 * Two corrections to how the reference does it, and both matter more to us than to
 * them because we sell the ceiling.
 *
 * ## Charged on receipt, not on attempt
 *
 * Theirs charges when a step starts and refunds when the step turns out never to have
 * reached the provider, after a compaction that restarted it, after a failover, after
 * a correction that cancelled the request in flight. The rule is right. The
 * implementation puts a refund in seven places, each remembering to decrement a mirror
 * counter too, and their own comment records the bug that follows: every skipped turn
 * leaked one unit of budget for the life of the process.
 *
 * Inverting it removes all seven sites. Nothing is charged until something came back,
 * so there is nothing to give back. A step that never reached the provider costs
 * nothing because it was never charged, rather than because somebody remembered.
 *
 * ## The ceiling belongs to the tree
 *
 * Theirs gives every subagent its own counter and says plainly that the spend of a
 * parent plus its children can exceed the parent's ceiling. For a developer tool that
 * is a footnote. For us it is the difference between a ceiling and a suggestion: a
 * tenant limit that a delegation steps over is not a limit, and "the persona spent
 * more than its cap because it asked another persona to" is not an answer anybody
 * accepts.
 *
 * So one ledger is created per root turn and handed down. A child does not get its own;
 * it gets a view of the same one.
 */

/** What a run has spent so far. */
export interface Spend {
	readonly turns: number;
	readonly steps: number;
}

/** What a run may spend. An absent limit is unlimited, which is a deliberate choice. */
export interface Ceiling {
	readonly turns?: number;
	readonly steps?: number;
}

/** Whether there is room, and if not, which ceiling ran out. */
export type Room =
	| { readonly ok: true }
	| { readonly ok: false; readonly exhausted: "turns" | "steps"; readonly spent: number; readonly limit: number };

/**
 * One counter for a whole delegation tree.
 *
 * Deliberately not a class with a `spend()` that both checks and charges. Checking and
 * charging are different moments: the check happens before the work and the charge
 * after it came back, and a single method would have to do one of them at the wrong
 * time. Keeping them apart is what makes charge-on-receipt expressible at all.
 */
export class Ledger {
	private turns = 0;
	private steps = 0;

	constructor(private readonly ceiling: Ceiling = {}) {}

	/** What has been spent, by everything in this tree. */
	spent(): Spend {
		return { turns: this.turns, steps: this.steps };
	}

	/** Whether there is room to start something. Charges nothing. */
	room(): Room {
		if (this.ceiling.turns !== undefined && this.turns >= this.ceiling.turns) {
			return { ok: false, exhausted: "turns", spent: this.turns, limit: this.ceiling.turns };
		}
		if (this.ceiling.steps !== undefined && this.steps >= this.ceiling.steps) {
			return { ok: false, exhausted: "steps", spent: this.steps, limit: this.ceiling.steps };
		}
		return { ok: true };
	}

	/**
	 * Charges for a step that came back.
	 *
	 * Called after the provider answered, whatever it answered. A step that failed
	 * still cost what it cost; a step that never reached the provider never gets here,
	 * which is the whole point.
	 */
	chargeStep(): void {
		this.steps += 1;
	}

	/** Charges for a turn that closed. Same rule: it closed, so it happened. */
	chargeTurn(): void {
		this.turns += 1;
	}

	/**
	 * A ledger a child shares with its parent.
	 *
	 * The same object. There is no per-child copy to reconcile and no moment where two
	 * counters could disagree about what a tree has spent.
	 */
	forChild(): Ledger {
		return this;
	}
}

/** How a ceiling that ran out reads to a person. */
export function describeRoom(room: Room): string {
	if (room.ok) return "within budget";
	return (
		`this run has used ${room.spent} of ${room.limit} ${room.exhausted}, counted across ` +
		"the whole delegation tree"
	);
}
