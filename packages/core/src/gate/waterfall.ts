/**
 * The waterfall: every guard sees the call, and the answer is the lowest thing said.
 *
 * Deliberately not a chain where each guard hands to the next. A chain gives the first
 * guard the power to end the cascade, so the answer depends on registration order, and
 * a reordering somebody does for readability changes what the system permits. Here
 * **every guard runs** and the verdict is the meet of everything they said, so
 * ordering changes the order of the reasons and nothing else.
 *
 * That is what makes the cascade reorderable in the sense the plan asked for: not that
 * you may shuffle it and hope, but that shuffling it provably cannot change the
 * verdict. The property test says so over generated orderings, and the type says so
 * over guards nobody has written yet.
 *
 * ## Short-circuiting is a performance decision, and it is not made here
 *
 * Stopping at the first deny would be cheaper and would lose the other reasons. A call
 * refused for two independent reasons is a different fact from one refused for one: an
 * operator who widens the first reason needs to know the second is still there, or
 * they widen a scope and are surprised the call still does not run. The budget for a
 * decision is 150 ms and guards are pure and small, so the whole set costs less than
 * the confusion would.
 *
 * ## A guard that throws is a denial
 *
 * Not a skip. A guard that broke did not decide, and treating a broken guard as
 * silence is how a crash turns into a permission. It denies, it names itself, and the
 * failure travels with the decision so the record has something to route on rather
 * than a shrug.
 */

import { asKernelError } from "../kernel/errors.js";
import type { FrozenCall } from "./call.js";
import { decide, type Decision, type GuardOutcome } from "./verdict.js";

/** Something that can lower a verdict about a call, or say nothing. */
export interface Guard {
	readonly name: string;
	/**
	 * Synchronous on purpose.
	 *
	 * An asynchronous guard is a guard that can hang, and a call suspended mid-question
	 * is indistinguishable from one that was refused, except that nothing times out and
	 * nobody is told. Anything needing the network resolves before it becomes a guard;
	 * one that has not resolved yet is simply not registered, which leaves the decision
	 * to the rest rather than blocking it.
	 */
	check(call: FrozenCall): GuardOutcome;
}

/** A decision, plus what it was about. */
export interface GateResult extends Decision {
	readonly callId: string;
	readonly tool: string;
	readonly turn: string;
}

/**
 * Runs every guard and returns the lowest verdict any of them reached.
 *
 * With no guards at all the answer is `allow`, which is worth being explicit about:
 * this function decides nothing on its own. A deployment that mounts no guards has no
 * gate, and it is the composition, not this loop, that is responsible for there being
 * one. The daemon's own path refuses when the policy is missing, and that refusal is a
 * guard like any other rather than a special case hidden in here.
 */
export function runGuards(guards: readonly Guard[], call: FrozenCall): GateResult {
	const outcomes = guards.map((guard) => {
		let outcome: GuardOutcome;
		try {
			outcome = guard.check(call);
		} catch (thrown) {
			const failure = asKernelError(thrown, guard.name);
			outcome = {
				reduce: "deny",
				rule: `guard:${guard.name}`,
				reason: `the guard failed and therefore did not decide: ${failure.message}`,
			};
		}
		return { guard: guard.name, outcome };
	});

	return {
		...decide(outcomes),
		callId: call.callId,
		tool: call.tool,
		turn: call.turn,
	};
}

/**
 * A place to keep guards that a component can add to and have removed for it.
 *
 * Registration returns its undo, so a guard mounted by a component is unregistered
 * when that component's scope unwinds. Without that, a reloaded component leaves its
 * old guard behind and the call is judged twice by two versions of the same rule.
 */
export class GuardSet {
	private readonly guards: Guard[] = [];

	add(guard: Guard): () => void {
		if (this.guards.some((existing) => existing.name === guard.name)) {
			throw asKernelError(
				new Error(
					`a guard named "${guard.name}" is already registered. A name is how a ` +
						"refusal says who refused, so two of them make the reason ambiguous.",
				),
				guard.name,
			);
		}
		this.guards.push(guard);
		let removed = false;
		return () => {
			if (removed) return;
			removed = true;
			const at = this.guards.indexOf(guard);
			if (at >= 0) this.guards.splice(at, 1);
		};
	}

	/** The guards, in registration order. Order affects the reasons, never the verdict. */
	all(): readonly Guard[] {
		return [...this.guards];
	}

	decide(call: FrozenCall): GateResult {
		return runGuards(this.guards, call);
	}
}
