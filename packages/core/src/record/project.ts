/**
 * The state file, produced from the record instead of maintained beside it.
 *
 * This is the direction that was missing, and it is the one that matters. There
 * was already a way to turn a `state.json` into entries, which is how the
 * equivalence check proved the fold reproduces what the engine had. But as long as
 * the engine kept writing the file itself, there were two chains for one history:
 * the `mutation_log` inside `state.json`, hashed and linked, and the record, hashed
 * and linked. Two chains over the same facts can disagree, and nothing would say
 * which was right.
 *
 * With this, the file stops being a thing anybody writes. It is a view: run the
 * fold, print it. Delete it and it comes back identical. Edit it and the next print
 * overwrites the edit, which is the point rather than a limitation, because an
 * editable audit log is not an audit log.
 *
 * ## What the record cannot supply, and why that is right
 *
 * Identity. `persona_id`, `persona_version` and `schema_version` say which persona
 * this is and against which spec, and none of them is an event: they come from the
 * file that declares the persona. A record that carried them would be a record that
 * could disagree with the spec about whose history it is.
 *
 * So they are passed in, and the caller reads them from the persona. Everything
 * else on the file is a fold.
 *
 * ## The mutation log is the record, printed
 *
 * Every field `MutationLogEntry` needs is already on a `value` entry, including the
 * author and the moment. The one that is NOT copied is `prev_hash`: the record has
 * its own chain and re-printing its links into a second one would invite somebody
 * to verify the copy and believe they had verified the original. What is printed is
 * the entry's own hash, under the name the schema uses, so a reader following it
 * lands on the chain that is actually checked.
 */

import type { MutationLogEntry, StateFile } from "../persona.js";
import { requireActor } from "./actor.js";
import type { DerivedState } from "./derive.js";
import { isGenesis, type RecordEntry } from "./entry.js";

/** What the persona says about itself, which the record has no business knowing. */
export interface Identity {
	readonly schemaVersion: string;
	readonly personaId: string;
	readonly personaVersion: string;
	readonly sessionId?: string;
}

/** The mutation log, printed from the value entries in the order they happened. */
export function mutationLog(entries: readonly RecordEntry[]): MutationLogEntry[] {
	const log: MutationLogEntry[] = [];
	for (const entry of entries) {
		if (entry.body.type !== "value") continue;
		// A coordinate's starting position is not a change to it. The record writes
		// origins so the fold can explain where a number came from; the log is for
		// what moved, and printing origins into it would make every persona look as
		// though it had been adjusted on the day it was created.
		if (isGenesis(entry)) continue;
		const body = entry.body;
		log.push({
			ts: entry.at,
			field: body.field,
			from: body.from,
			to: body.to,
			// Straight through, because the entry keeps the same thing the file does. It
			// briefly kept the position instead, and every row of a real persona came out
			// with 1.01 where the move was 0.02. The migration tests did not see it: they
			// compare rows that came IN, and this is what goes OUT.
			delta_requested: body.delta,
			clamped: body.clamped,
			reason: body.reason,
			// Refuses rather than inventing a word, and the refusal is unreachable in
			// practice because `mutate` rejects an unprintable author when the entry is
			// written. It stays here so the correspondence is enforced where it is used
			// and not only where it is checked.
			actor: requireActor(entry.author),
			governance_blocked: body.blocked,
			// Where it was written, printed only when the entry knew it. Writing the
			// keys with undefined values would put `origin_node: null` on every row of
			// a single-machine persona, and the schema has no null there.
			...(entry.provenance?.node === undefined ? {} : { origin_node: entry.provenance.node }),
			...(entry.provenance?.session === undefined
				? {}
				: { session_id: entry.provenance.session }),
			...(entry.provenance?.toolCall === undefined
				? {}
				: { tool_call_id: entry.provenance.toolCall }),
			// The record's own link, not a second chain over the same facts.
			prev_hash: entry.prev,
			hash: entry.hash,
		});
	}
	return log;
}

/**
 * The whole file, from the fold and the entries.
 *
 * Both, and not just the fold, because the two answer different questions: the fold
 * says where the persona is now and the entries say how it got there. A projection
 * built from the fold alone would have to keep a copy of the history to print the
 * log, which is the duplication this exists to remove.
 */
export function project(
	state: DerivedState,
	entries: readonly RecordEntry[],
	identity: Identity,
): StateFile {
	const file: StateFile = {
		schema_version: identity.schemaVersion,
		persona_id: identity.personaId,
		persona_version: identity.personaVersion,
		...(identity.sessionId === undefined ? {} : { session_id: identity.sessionId }),
		values: { ...state.values },
		mutation_log: mutationLog(entries),
	};

	if (state.context) {
		file.active_context = {
			task_mode: state.context.taskMode,
			audience: state.context.audience,
			...(state.context.flags.length === 0
				? {}
				: { additional_context_flags: [...state.context.flags] }),
		};
		if (state.context.anchors.length > 0) {
			file.memory_anchors_active = [...state.context.anchors];
		}
	}

	if (state.compiled) {
		file.last_compiled_at = state.compiled.at;
		file.last_compiled_hash = state.compiled.hash;
	}

	// The session block, folded from the turns rather than kept beside them.
	//
	// The agent used to write this itself, straight into `state.json`, while this
	// printed its own version from the record: two writers for one block, disagreeing
	// in two fields and settling on whichever ran last. On a real turn the agent wrote
	// `stop_reason: "goal_met"` and the projection said `answered`, and the file
	// flip-flopped between them as the turn and the next coordinate move landed.
	//
	// So this is the only writer, and it says what the agent's said, from the entries.
	// `active_task` is what the persona is in the middle of: the open turn's question,
	// or the last one's when that turn ended badly, which is the pointer a resumed run
	// is told not to restart. A turn that ended well leaves nothing to resume.
	//
	// A persona with nothing open and nothing spent gets no block at all, because an
	// empty one reads as "a session happened and did nothing".
	const ran = state.turnCount > 0 || state.openTurn !== undefined;
	if (ran) {
		const last = state.lastTurn;
		// `answered` and nothing else. This asked `answered(outcome)` first, which is the
		// question "did somebody get a reply" and includes a turn that ran out of room:
		// a half-finished task would have reported nothing to resume. An entry also holds
		// whatever word was written into it, including one from a build that knew a
		// reason this one does not, and comparing against the one word that means
		// finished errs toward "there is something to resume". A stale pointer is a
		// smaller lie than a lost one.
		const unfinished = last !== undefined && last.outcome !== "answered" ? last.prompt : null;
		file.agent_session = {
			active_task: state.openTurn?.prompt ?? unfinished,
			started_at: state.openTurn?.at ?? null,
			step_count: state.spent.steps,
			token_count: state.spent.tokens,
			cost_usd: state.spent.usd,
			stop_reason: state.openTurn === undefined ? (last?.outcome ?? null) : null,
		};
	}

	return file;
}

/** How a stored state file differs from the one the record says it should be. */
export interface Divergence {
	/** Coordinates the file and the record disagree about, with both numbers. */
	readonly values: readonly { field: string; stored: number | undefined; recorded: number }[];
	/**
	 * Whether the documents differ at all, values or not.
	 *
	 * Separate from `values` because they are not the same question and only one of
	 * them is actionable by a person. A log the file lost, or a session block it
	 * gained, is a file that no longer says what the record says even though every
	 * coordinate agrees, and reprinting is still the right answer.
	 */
	readonly differs: boolean;
}

/**
 * Compare a stored state file with the one the record projects.
 *
 * Not `compareToStored`, which asks a different question that reads almost the same
 * in English: that one replays a state file's OWN log against its OWN values, which
 * is one document checked against itself and is what proved the migration. This is
 * the file against the record, which is the check that means anything once the
 * record is the source.
 *
 * A missing file differs from every record, which is what makes "delete it and it
 * comes back" a repair rather than a special case.
 */
export function divergence(recorded: StateFile, stored: StateFile | undefined): Divergence {
	const values: { field: string; stored: number | undefined; recorded: number }[] = [];
	for (const [field, value] of Object.entries(recorded.values)) {
		const held = stored?.values?.[field];
		if (held !== value) values.push({ field, stored: held, recorded: value });
	}

	return {
		values,
		differs: stored === undefined || JSON.stringify(stored) !== JSON.stringify(recorded),
	};
}
