/**
 * Handing work to another persona, and what it may do when it gets there.
 *
 * This is where the most useful thing the study found lands, and it lands as a
 * correction rather than as a feature. The reference wrote the decision twice: once
 * inheriting the parent's approval posture, and once reversing that with the reason. It
 * shipped the first version, and what it produced was children blocked on a permission
 * question no surface displayed, so **a permission-blocked child was indistinguishable
 * from a working one**.
 *
 * Two rules come out of it, and they are not the same rule.
 *
 * ## The scope is a photograph, taken at the moment of delegating
 *
 * A child gets a snapshot of what its parent **explicitly** held, not what the
 * deployment defaults to. Defaults belong to the operator and can change; a parent that
 * never narrowed anything hands down nothing and its child follows the current default.
 *
 * Resolving it live instead, by walking up to the parent on every call, is the thing
 * they rejected, with three reasons of which the third is ours: **a parent that widens
 * its own scope mid-run would retroactively widen a child that is already running**.
 * The photograph is the semantics. To tighten a child you cancel it and delegate again.
 *
 * And the photograph goes into the child's own record, so its effective scope
 * reconstructs from its own chain and from nothing else. That is what makes "what could
 * this sub-persona reach on Tuesday at three" a question with an answer.
 *
 * ## A delegated child does not ask
 *
 * We already hold this on the machine path: the hook never returns "ask", because
 * escalating to a host's own prompt puts the question in front of whoever happens to be
 * at that keyboard when the point of a gate is that a named person with the right role
 * answers it. A gate the daemon cannot resolve is a denial.
 *
 * The same rule runs downward. A delegated child's asks resolve to denials
 * deterministically, and widening is always a decision on the parent's side. That is
 * what stops the state the reference had to ship twice to escape.
 *
 * ## Depth only ever goes up
 *
 * A resumed child cannot be re-counted as a root. The persisted depth is authoritative
 * and runtime options may deepen it and never lower it, which is the difference between
 * a delegation limit and a suggestion.
 */

import type { Author } from "../record/entry.js";
import type { Ledger } from "./budget.js";

/** What a persona explicitly narrowed for itself. Absent means it narrowed nothing. */
export interface ExplicitScope {
	/** Directories it confined itself to, if it did. */
	readonly directories?: readonly string[];
	/** Its sandbox posture, if it set one. */
	readonly sandbox?: string;
}

/** The scope a child runs under, and where each part of it came from. */
export interface DelegatedScope {
	/** Copied from the parent's explicit narrowing. Empty means: follow the default. */
	readonly inherited: ExplicitScope;
	/** Always. A delegated child does not ask; it refuses and reports. */
	readonly asks: false;
	/** How deep this child sits. Monotone: it never goes down. */
	readonly depth: number;
	/** When the photograph was taken, so the record can say what it was of. */
	readonly at: string;
}

export interface DelegationRequest {
	readonly parentDepth: number;
	readonly parentScope: ExplicitScope;
	readonly maxDepth?: number;
	readonly now?: () => Date;
}

export type DelegationResult =
	| { readonly ok: true; readonly scope: DelegatedScope }
	| { readonly ok: false; readonly reason: string };

/**
 * Takes the photograph.
 *
 * Only the explicit parts are copied. A parent that narrowed nothing hands down
 * nothing, and its child follows whatever the deployment currently says, which is what
 * keeps an operator's later change from being frozen into every child ever delegated.
 */
export function delegate(request: DelegationRequest): DelegationResult {
	const depth = request.parentDepth + 1;
	if (request.maxDepth !== undefined && depth > request.maxDepth) {
		return {
			ok: false,
			reason: `this would be delegation depth ${depth}, past the declared limit of ${request.maxDepth}`,
		};
	}

	const inherited: ExplicitScope = {
		...(request.parentScope.directories !== undefined
			? { directories: [...request.parentScope.directories] }
			: {}),
		...(request.parentScope.sandbox !== undefined ? { sandbox: request.parentScope.sandbox } : {}),
	};

	return {
		ok: true,
		scope: {
			inherited,
			asks: false,
			depth,
			at: (request.now ?? (() => new Date()))().toISOString(),
		},
	};
}

/**
 * Deepens a depth without ever lowering it.
 *
 * A resumed child reads its depth from what was persisted, and a runtime option that
 * said otherwise would let a resume launder a grandchild into a root. Taking the larger
 * of the two is the whole rule.
 */
export function deepen(persisted: number, offered: number): number {
	return Math.max(persisted, offered);
}

/**
 * What a delegated child is told about its own limits.
 *
 * Two measured findings pull in opposite directions here and both are true, which is
 * why this exists as a separate string rather than as a line in a system prompt.
 *
 * Putting the confinement mode in the **stable system prompt** measurably stopped the
 * model trying: five of twelve turns in their first manual session ended with no tool
 * call at all, and they reverted it. Telling a delegated child the same facts as a
 * **runtime-context statement**, with the system prompt left identical between parent
 * and child, is what they do now and keep.
 *
 * So the placement is the variable, not the telling. Our compiled identity is system
 * prompt; the scope of this particular delegation is not, and this is the text that
 * carries it.
 */
export function scopeStatement(scope: DelegatedScope): string {
	const parts = [
		"Your scope was fixed when this work was handed to you and cannot be widened from here.",
		"Operations that would need approval are refused automatically rather than queued.",
		"A task that needs wider access ends with the limitation reported, not with retries.",
	];
	if (scope.inherited.directories?.length) {
		parts.push(`You are working within: ${scope.inherited.directories.join(", ")}.`);
	}
	return parts.join(" ");
}

/** The author a delegation-scope entry carries in the child's record. */
export function delegationAuthor(parentId: string): Author {
	return {
		kind: "runtime",
		mechanism: "delegation",
		reason: `scope photographed from ${parentId} at the moment the work was handed over`,
	};
}

/**
 * A child's ledger.
 *
 * The parent's, unchanged. Written as a named function rather than left to a call site
 * passing the right object, because "give the child its own" is the obvious thing to
 * write and is exactly the mistake: the reference does it and says plainly that a
 * delegation tree can then exceed its parent's ceiling.
 */
export function ledgerForChild(parent: Ledger): Ledger {
	return parent.forChild();
}
