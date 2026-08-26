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
	/**
	 * How many turns have closed, and how the last one did.
	 *
	 * A count and the last, rather than every turn in order, for the reason `surface`
	 * gives below and which the list version quietly broke: this is the state fold, so
	 * it answers what the persona is now. Every turn it ever took is in the entries,
	 * which is where an audit reading history goes.
	 *
	 * It is not only a tidiness argument. A fold that keeps a growing array cannot be
	 * checkpointed, because the checkpoint grows with the history it exists to let you
	 * skip. Nothing ever read the whole array: the projection used its length and its
	 * last element, and nothing else in the codebase touched it.
	 */
	readonly turnCount: number;
	/** How the last turn that closed did, absent when none has. */
	readonly lastTurn?: { id: string; outcome: string; synthetic: boolean };
	/**
	 * How many calls the gate has refused, and the last one.
	 *
	 * A refusal is the half an audit reads first, and an audit reads the entries. What
	 * belongs in the state is how many there have been and what the most recent was.
	 */
	readonly denialCount: number;
	readonly lastDenial?: { turn: string; callId: string; tool: string; reason?: string };
	/**
	 * The last set of tools put in front of the model, and why.
	 *
	 * Last rather than every, because this is the state fold: what a persona could
	 * reach *now*. Every surface it ever had is in the entries, which is where an
	 * audit reading history goes.
	 */
	readonly surface?: { turn: string; tools: readonly string[]; reason: string };
	/**
	 * The situation in force: the last one anybody set.
	 *
	 * Last-wins, like every other coordinate here. Absent means nobody has said,
	 * which is not the same as an empty situation and is why this is optional.
	 */
	readonly context?: {
		readonly taskMode: string | null;
		readonly audience: string | null;
		readonly flags: readonly string[];
		readonly anchors: readonly string[];
	};
	/** The last compile, and what it produced. */
	readonly compiled?: { readonly at: string; readonly hash: string };
	/**
	 * What the closed turns have cost, added up here rather than stored anywhere.
	 *
	 * A total kept beside the entries is a number that can disagree with them. This
	 * one cannot: it is the entries.
	 */
	readonly spent: { readonly steps: number; readonly tokens: number; readonly usd: number };
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
	turnCount: 0,
	denialCount: 0,
	// Zeros and not absent: a persona that has run nothing has spent nothing, and
	// that is a fact rather than a gap.
	spent: { steps: 0, tokens: 0, usd: 0 },
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

	return { ok: true, state: fold(EMPTY, entries) };
}

/**
 * Folds a tail onto a state a checkpoint already established.
 *
 * The chain is checked from where the tail claims to start rather than from zero,
 * because that is where it does start: a tail's first entry has a sequence number
 * that is not zero and a `prev` pointing at an entry the reader deliberately did not
 * load. Checking it as though it were a whole chain reports a break at its first
 * entry, which is a true statement about the wrong question.
 *
 * This trades reading the whole history for reading the end of it, and says so. What
 * it does NOT trade is the tail's own integrity: an edited entry after the checkpoint
 * still fails, and `derive` over everything remains the answer when proof is what is
 * wanted rather than speed.
 */
export function deriveFrom(
	start: DerivedState,
	entries: readonly RecordEntry[],
	from: { seq: number; prev: string },
): DeriveResult {
	const verdict = verify(entries, from);
	if (!verdict.ok) return { ok: false, problem: verdict.problem! };

	// Counted from where the tail begins rather than from the checkpoint's own count,
	// because the checkpoint entry is itself an entry and its state was folded over
	// everything BEFORE it. Adding the tail to that number loses exactly one, and a
	// state that says it is a fold over one fewer entries than it is would not match
	// the same state derived the long way.
	return { ok: true, state: { ...fold(start, entries), through: from.seq + entries.length } };
}

/**
 * The fold itself, from a starting state.
 *
 * Checkpoints are SKIPPED here, and that is the property that makes them safe. A
 * checkpoint is a claim about what the entries before it add up to, and folding it
 * would mean believing the claim; skipping it means folding from zero always gives
 * the truth, and a checkpoint can therefore be checked against the truth rather than
 * trusted in place of it.
 */
function fold(start: DerivedState, entries: readonly RecordEntry[]): DerivedState {
	const values: Record<string, number> = { ...start.values };
	const components: Record<string, { state: string; epoch?: string }> = { ...start.components };
	let turnCount = start.turnCount;
	let lastTurn = start.lastTurn;
	let denialCount = start.denialCount;
	let lastDenial = start.lastDenial;
	let openTurn: string | undefined = start.openTurn;
	let surface: { turn: string; tools: readonly string[]; reason: string } | undefined = start.surface;
	let context: DerivedState["context"] = start.context;
	let compiled: DerivedState["compiled"] = start.compiled;
	const spent = { ...start.spent };

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
				turnCount += 1;
				lastTurn = { id: body.turn, outcome: body.outcome, synthetic: body.synthetic };
				if (openTurn === body.turn) openTurn = undefined;
				// Absent is not zero: a turn whose provider reported nothing adds
				// nothing, and a turn that cost nothing already says so with zeros.
				if (body.spent) {
					spent.steps += body.spent.steps;
					spent.tokens += body.spent.tokens;
					spent.usd += body.spent.usd;
				}
				break;
			case "context":
				context = {
					taskMode: body.taskMode,
					audience: body.audience,
					flags: body.flags,
					anchors: body.anchors,
				};
				break;
			case "compiled":
				// `at` is the entry's own timestamp, not a field somebody could set to
				// something else. When it happened is the record's to say.
				compiled = { at: entry.at, hash: body.hash };
				break;
			case "call":
				if (body.verdict === "denied") {
					denialCount += 1;
					lastDenial = {
						turn: body.turn,
						callId: body.callId,
						tool: body.tool,
						...(body.reason === undefined ? {} : { reason: body.reason }),
					};
				}
				break;
			case "surface":
				surface = { turn: body.turn, tools: body.tools, reason: body.reason };
				break;
			case "checkpoint":
				// Skipped on purpose. See the note on `fold`: a checkpoint is a claim
				// about what came before it, and folding from zero has to be the answer
				// that claim is checked against rather than one it can replace.
				break;
			case "message":
			case "failure":
				// Facts worth keeping and not part of the persona's current position.
				break;
		}
	}

	return {
		values,
		components,
		...(openTurn === undefined ? {} : { openTurn }),
		turnCount,
		...(lastTurn === undefined ? {} : { lastTurn }),
		denialCount,
		...(lastDenial === undefined ? {} : { lastDenial }),
		...(surface === undefined ? {} : { surface }),
		...(context === undefined ? {} : { context }),
		...(compiled === undefined ? {} : { compiled }),
		spent,
		through: start.through + entries.length,
	};
}

/** The empty state, for a persona whose record has nothing in it yet. */
export function emptyState(): DerivedState {
	return EMPTY;
}
