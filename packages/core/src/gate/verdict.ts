/**
 * A refusal no ordering can undo.
 *
 * Three verdicts with an order between them, most permissive first:
 *
 *     allow  >  ask  >  deny
 *
 * Combining two is the lower of the two. That is the whole mechanism, and
 * everything else here exists to make sure nothing can climb back up it.
 *
 * ## The guarantee is the compiler's, not a test's
 *
 * `GuardOutcome` **has no allow case**. A guard can decline to have an opinion, or it
 * can reduce, and there is no third thing it can return. So no arrangement of guards
 * turns a denial into a permission, and no future guard can be written that does,
 * because the type will not let it be spelled.
 *
 * A test would have to enumerate orderings and would be one clever guard away from
 * being wrong. This is the difference between checking a property and making its
 * negation unwritable.
 *
 * ## Why "ask" sits in the middle rather than beside
 *
 * A gate that opens is not the same as a permission, and a gate on a denied call must
 * never open. Making ask a point on the same scale is what gets that for free: `min`
 * of ask and deny is deny, so a guard that wants a person to look cannot rescue a
 * call another guard already refused. Modelling ask as a separate flag is how a
 * codebase ends up with a gate that opened on something already denied.
 */

/** The three answers, ordered by how much they permit. */
export type Verdict = "allow" | "ask" | "deny";

const RANK: Record<Verdict, number> = { deny: 0, ask: 1, allow: 2 };

/** The lower of two verdicts. Associative, commutative, and `allow` is the identity. */
export function meet(left: Verdict, right: Verdict): Verdict {
	return RANK[left] <= RANK[right] ? left : right;
}

/** Whether `left` permits at least as much as `right`. */
export function permitsAtLeast(left: Verdict, right: Verdict): boolean {
	return RANK[left] >= RANK[right];
}

/**
 * What a guard is allowed to say.
 *
 * `undefined` is "I have no opinion", which is the common case and should be cheap to
 * write. The two objects are reductions, and each carries a reason because a refusal
 * that will not name itself sends somebody debugging in the wrong direction. Every
 * path that is not a clear allow denies **and says which no it is**.
 *
 * Note what is missing and cannot be added without changing this type: there is no
 * `{ allow: ... }`.
 */
export type GuardOutcome =
	| undefined
	| { readonly reduce: "deny"; readonly reason: string; readonly rule: string }
	| { readonly reduce: "ask"; readonly reason: string; readonly rule: string };

/** Says no, and says which no. */
export function deny(rule: string, reason: string): GuardOutcome {
	return { reduce: "deny", reason, rule };
}

/** Asks a person, and says what for. */
export function ask(rule: string, reason: string): GuardOutcome {
	return { reduce: "ask", reason, rule };
}

/** One guard's contribution to the answer, kept so the record can name it. */
export interface Contribution {
	readonly guard: string;
	readonly rule: string;
	readonly verdict: Exclude<Verdict, "allow">;
	readonly reason: string;
}

/** Where a chain of guards ended up. */
export interface Decision {
	readonly verdict: Verdict;
	/**
	 * Every reduction, in the order the guards ran.
	 *
	 * All of them, not just the one that won. A call denied for two independent
	 * reasons is a different fact from a call denied for one, and an operator
	 * widening the first reason needs to know the second is still there. Reporting
	 * only the strongest is how somebody grants a permission and is surprised the
	 * call still does not run.
	 */
	readonly contributions: readonly Contribution[];
}

/** Folds outcomes into a decision. Starts at allow, and can only go down from there. */
export function decide(
	outcomes: readonly { guard: string; outcome: GuardOutcome }[],
): Decision {
	let verdict: Verdict = "allow";
	const contributions: Contribution[] = [];
	for (const { guard, outcome } of outcomes) {
		if (!outcome) continue;
		verdict = meet(verdict, outcome.reduce);
		contributions.push({
			guard,
			rule: outcome.rule,
			verdict: outcome.reduce,
			reason: outcome.reason,
		});
	}
	return { verdict, contributions };
}
