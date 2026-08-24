/**
 * The two seams between the record and everything that already exists.
 *
 * One points forward: the kernel's lifecycle goes into the same record as everything
 * else, so what a persona could reach is a fold over one chain rather than a
 * correlation across two.
 *
 * One points back: the existing `state.json` can be replayed into a record, which is
 * how the equivalence is proved on real personas rather than on fixtures. The old
 * copy is not retired until that holds.
 */

import type { Kernel, LifecycleEvent } from "../kernel/index.js";
import { LIFECYCLE } from "../kernel/index.js";
import type { MutationLogEntry, StateFile } from "../persona.js";
import { GENESIS, type Author, type RecordEntry } from "./entry.js";
import { chain, head } from "./chain.js";
import { derive } from "./derive.js";
import type { Journal } from "./journal.js";

/**
 * Sends every mount, suspension and reload into the record.
 *
 * This is the half no harness has. Unwinding correctly makes a kernel correct;
 * writing down each mount with the epoch it resolved to is what lets somebody answer
 * **what this agent could reach on Tuesday at three**, months later, from a chain
 * that cannot have been edited since.
 *
 * The author is the kernel rather than the component, and the distinction matters. A
 * component did not decide to be suspended; the kernel decided, because something the
 * component declared went away. Attributing the entry to the component would put a
 * decision in its mouth that it did not make.
 */
export function recordLifecycle(kernel: Kernel, journal: Journal): () => void {
	return kernel.bus.onNotify(LIFECYCLE, "record", (change: LifecycleEvent) => {
		const author: Author = {
			kind: "runtime",
			mechanism: "kernel",
			reason: change.reason ?? `${change.from} to ${change.to}`,
		};
		journal.append(author, {
			type: "lifecycle",
			component: change.component,
			from: change.from,
			to: change.to,
			...(change.epoch === undefined ? {} : { epoch: change.epoch }),
			...(change.reason === undefined ? {} : { reason: change.reason }),
		});
	});
}

/**
 * How an old mutation entry's actor maps onto an author.
 *
 * The old vocabulary is five strings that mix who acted with what mechanism acted,
 * which is why it could default. Mapping it out is the migration doing the work the
 * original schema left undone: a decayed value was written by the runtime and says
 * which mechanism, a corrected one by a judge, and only `human-operator` is a person.
 *
 * `human-operator` becomes an unnamed human rather than being invented into a real
 * identity. A migration that guessed a name would put a person's name on entries they
 * may never have written, which is the forgery the invariant exists to prevent, only
 * committed by us instead of by a bug.
 */
function authorOf(actor: MutationLogEntry["actor"]): Author {
	switch (actor) {
		case "human-operator":
			return { kind: "human", id: "unattributed-operator" };
		case "actor-llm":
			return { kind: "persona", id: "self" };
		case "runtime-decay":
			return {
				kind: "runtime",
				mechanism: "homeostasis",
				reason: "declared half-life pulled the value toward its mean",
			};
		case "runtime-context":
			return {
				kind: "runtime",
				mechanism: "context",
				reason: "the active context changed what this coordinate should be",
			};
		case "judge-correction":
			return {
				kind: "runtime",
				mechanism: "judge",
				reason: "an evaluation corrected the value",
			};
		default:
			// A string outside the five the schema declares: a hand edit, a file from a
			// version this build has not learned, or a typo. It gets an author that
			// SAYS it is unrecognised and carries the original word.
			//
			// The alternative was what this used to do, which was fall off the end and
			// return undefined. An entry with no author does not verify, so one strange
			// actor made the whole chain unreadable and the failure pointed at the
			// chain rather than at the word that caused it. Naming it keeps the record
			// verifiable and keeps the anomaly visible, which is the pair this file
			// exists to preserve.
			return {
				kind: "runtime",
				mechanism: "unrecognised-actor",
				reason: `the state file attributed this to "${String(actor)}", which is not one this build knows`,
			};
	}
}

/**
 * Where a coordinate started, before anything moved it.
 *
 * Working this out is not cosmetic, and finding that it had to be worked out at all
 * is the most useful thing this migration turned up. A state file is initialised with
 * every declared coordinate at its envelope mean, and **nothing records that**: the
 * numbers appear in `values` with nobody named. Only the ones that later move get an
 * audited entry, so a persona that never moved a trait carries a value no chain can
 * account for.
 *
 * On a real persona this is most of them. The reference example carries twelve
 * coordinates and four mutations, so eleven values had no origin anybody could point
 * at. That is a small hole in an ordinary log and an unacceptable one in a chain we
 * sell as proof, because "where did this number come from" is the first question and
 * the honest answer was nowhere.
 *
 * It is recoverable without guessing. A field the log touched started at the `from`
 * of its first entry; a field the log never touched has not moved, so its current
 * value **is** where it started. Both come out of the file rather than out of an
 * assumption, and the entry says the runtime wrote them at initialisation, which is
 * what happened.
 */
function genesisValues(state: StateFile): Record<string, number> {
	const first: Record<string, number> = {};
	for (const old of state.mutation_log ?? []) {
		if (!(old.field in first)) first[old.field] = old.from;
	}
	const origin: Record<string, number> = {};
	for (const [field, current] of Object.entries(state.values ?? {})) {
		origin[field] = field in first ? first[field]! : current;
	}
	// A log may name a field the stored copy dropped. It still had an origin.
	for (const [field, from] of Object.entries(first)) {
		if (!(field in origin)) origin[field] = from;
	}
	return origin;
}

/**
 * Replays an existing state file into a record.
 *
 * The mutation log is the only part of the old file that is a history, so it is what
 * gets replayed, preceded by the genesis entries that explain where each coordinate
 * started. `values` itself is never replayed: it is the derived copy, and replaying
 * the answer would make the equivalence check pass by construction and prove nothing.
 *
 * Timestamps come from the entries. Order comes from the array. A log whose entries
 * are not in time order still replays in array order, because the array is what the
 * old engine appended to and therefore what it actually meant.
 */
export function replayStateFile(state: StateFile): RecordEntry[] {
	const entries: RecordEntry[] = [];
	const first = state.mutation_log?.[0]?.ts;
	const at = first ?? new Date(0).toISOString();
	const origin = genesisValues(state);
	for (const field of Object.keys(origin).sort()) {
		const value = origin[field]!;
		const draft = {
			at,
			author: {
				kind: "runtime" as const,
				mechanism: GENESIS,
				reason: "the coordinate was initialised from its declared envelope",
			},
			body: {
				type: "value" as const,
				field,
				from: value,
				to: value,
				requested: 0,
				clamped: false,
				blocked: false,
				reason: "initialised",
			},
		};
		entries.push(chain(draft, entries.length, head(entries)));
	}
	for (const old of state.mutation_log ?? []) {
		const draft = {
			at: old.ts,
			author: authorOf(old.actor),
			body: {
				type: "value" as const,
				field: old.field,
				from: old.from,
				to: old.to,
				requested: old.delta_requested,
				clamped: old.clamped,
				blocked: old.governance_blocked ?? false,
				reason: old.reason,
			},
		};
		entries.push(chain(draft, entries.length, head(entries)));
	}
	return entries;
}

/** What a comparison between the derived state and the stored one found. */
export interface EquivalenceReport {
	readonly ok: boolean;
	/**
	 * Fields the log touched where folding from genesis disagrees with the stored
	 * copy. This is the half with teeth: one of the two is wrong and the engine has
	 * been running on whichever it happened to read.
	 */
	readonly mismatches: readonly { field: string; stored: number; derived: number }[];
	/**
	 * Coordinates with no audited history at all, whose value rests entirely on the
	 * genesis entry reconstructed from the file.
	 *
	 * Not a failure, and deliberately not called one. It is the honest count of how
	 * much of a persona's position nobody can point at a reason for, which on the
	 * reference example is eleven values out of twelve. It shrinks on its own as the
	 * record becomes the source, because then initialisation is written down when it
	 * happens instead of being reconstructed afterwards.
	 */
	readonly unaudited: readonly string[];
	/** How many entries the derivation folded, genesis included. */
	readonly folded: number;
}

/**
 * Checks that deriving from the log gives what the stored copy says.
 *
 * Only the fields the log actually touched can disagree, and that is the whole
 * check. Seeding the fold from the stored copy is what makes genesis honest, and it
 * also means an untouched coordinate agrees by construction: there is nothing left to
 * compare.
 *
 * That is worth saying out loud, because the first version of this reported an
 * "unexplained" field and, once genesis existed, **that condition could no longer
 * fire**. A check that cannot fail is worse than no check: it reads as coverage. It
 * was replaced by `unaudited`, which measures something real, that most of a
 * persona's position rests on values nobody wrote down a reason for.
 *
 * Both are exactly the class of divergence that stops being possible once the fold is
 * the only source.
 */
export function compareToStored(state: StateFile): EquivalenceReport {
	const replayed = replayStateFile(state);
	const result = derive(replayed);
	if (!result.ok) {
		return { ok: false, mismatches: [], unaudited: [], folded: 0 };
	}

	const derived = result.state.values;
	const touched = new Set((state.mutation_log ?? []).map((entry) => entry.field));
	const mismatches: { field: string; stored: number; derived: number }[] = [];
	const unaudited: string[] = [];

	for (const [field, stored] of Object.entries(state.values ?? {})) {
		if (!touched.has(field)) {
			unaudited.push(field);
			continue;
		}
		// Coordinates are floats produced by additions, so two paths to the same value
		// can differ in the last bits. The tolerance is far below anything the spec can
		// express and far above float noise.
		if (Math.abs((derived[field] ?? Number.NaN) - stored) > 1e-9) {
			mismatches.push({ field, stored, derived: derived[field] ?? Number.NaN });
		}
	}

	return {
		ok: mismatches.length === 0,
		mismatches,
		unaudited,
		folded: replayed.length,
	};
}
