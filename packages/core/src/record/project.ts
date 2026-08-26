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

	// The open turn is the active task, and the totals are the fold over closed ones.
	// A persona with nothing open and nothing spent gets no session block at all,
	// because an empty one reads as "a session happened and did nothing".
	const ran = state.turns.length > 0 || state.openTurn !== undefined;
	if (ran) {
		const last = state.turns.at(-1);
		file.agent_session = {
			active_task: state.openTurn ?? null,
			started_at: null,
			step_count: state.spent.steps,
			token_count: state.spent.tokens,
			cost_usd: state.spent.usd,
			stop_reason: state.openTurn === undefined ? (last?.outcome ?? null) : null,
		};
	}

	return file;
}
