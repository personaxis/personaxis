/**
 * What is being decided about, frozen before anyone decides.
 *
 * A call is materialised once, given an identity, and made immutable. Then it goes
 * to the guards. Nothing downstream can change it, and that is not tidiness.
 *
 * ## Four views have to agree about what was asked
 *
 * The record says what was requested. The audit shows an operator what was requested.
 * The interface shows a person what they are approving. And the executor runs what was
 * requested. If a guard could rewrite the arguments, those four stop being the same
 * thing: somebody approves one command and another one runs, and the record says a
 * third. The gate is the last place all four are still one object, so it is the place
 * to freeze it.
 *
 * That also settles a question that otherwise comes up every few months. A guard that
 * wants to narrow a call, redact a path, add a flag, cannot. It can only refuse and
 * say why, and the caller may then make a different call. Rewriting an input that has
 * already been recorded is not narrowing; it is making the record wrong.
 *
 * ## The identity is minted once and carried everywhere
 *
 * One `callId` ties the proposal, the verdict, and the result together. Minting it at
 * the gate rather than at the executor is what makes a **refused** call traceable:
 * a call that never ran still has an identity, so a workspace can show it, an
 * operator can widen a scope and point at it, and the record can carry it.
 */

import { createHash } from "node:crypto";

import { callFacts, type ActionClass } from "../enforcement/action-classes.js";

/** The projected effect of a call on one declared coordinate. */
export interface CoordinateEffect {
	readonly field: string;
	/** Where the coordinate would end up if this call ran. */
	readonly to: number;
}

/** A call, materialised and frozen. */
export interface FrozenCall {
	readonly callId: string;
	readonly tool: string;
	/** The arguments as text, which is what the policy reasons about. */
	readonly argsText: string;
	readonly actionClasses: readonly ActionClass[];
	/**
	 * What this call would do to the persona's declared coordinates, when anything
	 * knows.
	 *
	 * Empty is the ordinary case and means the second axis has nothing to weigh, not
	 * that the call is safe on that axis. Producing this is somebody else's job: an
	 * appraiser, a model, a rule. The gate weighs it and does not guess it, because a
	 * gate that estimated its own inputs would be marking its own homework.
	 */
	readonly effects: readonly CoordinateEffect[];
	/** Which turn it belongs to, so the record can group it. */
	readonly turn: string;
	/**
	 * E59: the tool is one the gate knows only reads. From `callFacts`, like the next one,
	 * and frozen with the rest so every guard judges the same facts.
	 */
	readonly knownRead: boolean;
	/**
	 * E59: every path the call names is inside the workspace root the caller gave, and for
	 * a write none is a protected folder. False when no root was given, which is the
	 * answer the gate gave before this existed.
	 */
	readonly withinWorkspace: boolean;
	/** E62: the call names a place outside the workspace. From `callFacts`. */
	readonly namesOutside: boolean;
	/** E62: a destructive shell command. From `callFacts`. */
	readonly destructive: boolean;
	/** E63: the call names a place under `.git` or `.personaxis`. From `callFacts`. */
	readonly touchesProtected: boolean;
}

export interface CallDraft {
	readonly tool: string;
	readonly argsText: string;
	readonly actionClasses?: readonly ActionClass[];
	readonly effects?: readonly CoordinateEffect[];
	readonly turn: string;
	/** Supply one to make a test deterministic. Otherwise it is derived. */
	readonly callId?: string;
	/** Where "inside" is measured from. Absent, nothing is inside. */
	readonly workspaceRoot?: string;
	/** Where a relative path in the arguments starts, when that is not the root. */
	readonly cwd?: string;
}

/**
 * Derives an id from what the call is, plus a nonce.
 *
 * Content alone would collide: the same tool with the same arguments twice in one turn
 * is ordinary, and two calls sharing an id would merge in the record into one call
 * with two verdicts. The nonce is what keeps them apart. The content half is not
 * decoration either, it makes an id from a different call recognisably different in a
 * log somebody is reading by eye.
 */
function mintId(draft: CallDraft, nonce: string): string {
	return createHash("sha256")
		.update(`${draft.turn}\u0000${draft.tool}\u0000${draft.argsText}\u0000${nonce}`)
		.digest("hex")
		.slice(0, 16);
}

let counter = 0;

/**
 * Materialises a call and freezes it.
 *
 * `Object.freeze` is shallow, so the arrays are frozen too. Without that, a guard
 * holding the call could push an action class and change what the next guard decides
 * about, which is the same defect as rewriting the arguments wearing a different hat.
 */
export function freezeCall(draft: CallDraft): FrozenCall {
	counter += 1;
	const facts = callFacts(draft.tool, draft.argsText, draft.workspaceRoot, draft.cwd);
	const call: FrozenCall = {
		callId: draft.callId ?? mintId(draft, `${counter}`),
		tool: draft.tool,
		argsText: draft.argsText,
		actionClasses: Object.freeze([...(draft.actionClasses ?? [])]),
		effects: Object.freeze([...(draft.effects ?? [])].map((effect) => Object.freeze({ ...effect }))),
		turn: draft.turn,
		knownRead: facts.knownRead,
		withinWorkspace: facts.withinWorkspace,
		namesOutside: facts.namesOutside,
		destructive: facts.destructive,
		touchesProtected: facts.touchesProtected,
	};
	return Object.freeze(call);
}
