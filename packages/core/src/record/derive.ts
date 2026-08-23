/**
 * The state, worked out from the record rather than kept beside it.
 *
 * Today `state.json` carries `values` **and** a mutation log that also carries every
 * from and to. Two places holding the same fact is two places that can disagree, and
 * the disagreement is silent: nothing checks them against each other, so the first
 * anyone knows is a persona that behaves like a value nobody can find in the audit.
 *
 * Inverting it removes the class. There is one place, and the other is a fold over
 * it. Divergence stops being unlikely and becomes unrepresentable.
 *
 * ## Derived and never stored
 *
 * Nothing here writes. A caller that wants to cache the result may, and the cache is
 * a cache: throwing it away and recomputing has to give the same answer, which is the
 * property `derived state matches the stored copy` checks over real states.
 *
 * ## Order is the contract
 *
 * The fold is last-wins per field, so it is only meaningful over a contiguous chain
 * in order. That is why verification runs first and why a hole is a refusal rather
 * than a gap to skip past: filtering entries out would leave a fold over a subset,
 * which is a different state that looks like a valid one.
 */

import { verify, type ChainProblem } from "./chain.js";
import type { RecordEntry } from "./entry.js";

/** What the persona is, as of the last entry folded. */
export interface DerivedState {
	/** Every declared coordinate that has ever moved, at its latest value. */
	readonly values: Readonly<Record<string, number>>;
	/** Which components are up, and the epoch each resolved to. */
	readonly components: Readonly<Record<string, { state: string; epoch?: string }>>;
	/** The turn currently open, if one is. */
	readonly openTurn?: string;
	/** Turns that closed, in order, with how. */
	readonly turns: readonly { id: string; outcome: string; synthetic: boolean }[];
	/** Calls the gate refused, which is the half an audit reads first. */
	readonly denials: readonly { turn: string; callId: string; tool: string; reason?: string }[];
	/**
	 * The last set of tools put in front of the model, and why.
	 *
	 * Last rather than every, because this is the state fold: what a persona could
	 * reach *now*. Every surface it ever had is in the entries, which is where an
	 * audit reading history goes.
	 */
	readonly surface?: { turn: string; tools: readonly string[]; reason: string };
	/** How many entries this state is a fold over. */
	readonly through: number;
}

export type DeriveResult =
	| { readonly ok: true; readonly state: DerivedState }
	/** The chain did not verify, so there is no state to report, only the problem. */
	| { readonly ok: false; readonly problem: ChainProblem };

const EMPTY: DerivedState = {
	values: {},
	components: {},
	turns: [],
	denials: [],
	through: 0,
};

/**
 * Folds a verified chain into the state it describes.
 *
 * Verification is not optional and not a separate step a caller might forget. A fold
 * over an unverified chain is a number somebody will quote, and quoting a number
 * derived from entries that may have been edited is worse than having no number.
 */
export function derive(entries: readonly RecordEntry[]): DeriveResult {
	const verdict = verify(entries);
	if (!verdict.ok) return { ok: false, problem: verdict.problem! };

	const values: Record<string, number> = {};
	const components: Record<string, { state: string; epoch?: string }> = {};
	const turns: { id: string; outcome: string; synthetic: boolean }[] = [];
	const denials: { turn: string; callId: string; tool: string; reason?: string }[] = [];
	let openTurn: string | undefined;
	let surface: { turn: string; tools: readonly string[]; reason: string } | undefined;

	for (const entry of entries) {
		const body = entry.body;
		switch (body.type) {
			case "value":
				// A blocked mutation moved nothing, and the entry records the attempt.
				// Folding `to` is right either way because a blocked entry has `to` equal
				// to `from`, which is what makes refusal auditable without a second rule.
				values[body.field] = body.to;
				break;
			case "lifecycle":
				components[body.component] =
					body.epoch === undefined ? { state: body.to } : { state: body.to, epoch: body.epoch };
				break;
			case "turn-open":
				openTurn = body.turn;
				break;
			case "turn-close":
				turns.push({ id: body.turn, outcome: body.outcome, synthetic: body.synthetic });
				if (openTurn === body.turn) openTurn = undefined;
				break;
			case "call":
				if (body.verdict === "denied") {
					denials.push({
						turn: body.turn,
						callId: body.callId,
						tool: body.tool,
						...(body.reason === undefined ? {} : { reason: body.reason }),
					});
				}
				break;
			case "surface":
				surface = { turn: body.turn, tools: body.tools, reason: body.reason };
				break;
			case "message":
			case "failure":
				// Facts worth keeping and not part of the persona's current position.
				break;
		}
	}

	return {
		ok: true,
		state: {
			values,
			components,
			...(openTurn === undefined ? {} : { openTurn }),
			turns,
			denials,
			...(surface === undefined ? {} : { surface }),
			through: entries.length,
		},
	};
}

/** The empty state, for a persona whose record has nothing in it yet. */
export function emptyState(): DerivedState {
	return EMPTY;
}
