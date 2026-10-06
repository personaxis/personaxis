/**
 * Moving a persona's coordinate, end to end, with the record as the source.
 *
 * The pieces existed and nothing joined them: `store.ts` gives the record a file,
 * `mutate.ts` writes a move into it, `project.ts` prints the state file from it, and
 * `bridge.ts` can turn an existing state file into entries. This is the one path that
 * uses all four, and it is what makes `state.json` a view rather than a second source.
 *
 * ## The migration happens on first touch, and only once
 *
 * A persona that exists today has its history inside `state.json` and an empty record.
 * Asking somebody to run a migration command is asking them to remember, and the ones
 * who forget end up with a record that starts mid-life and an audit that begins with a
 * persona appearing from nowhere.
 *
 * So the first write to an empty record replays what the state file already holds,
 * through the same bridge the equivalence tests use. After that the record is ahead of
 * the file and the replay never runs again, because the record is no longer empty.
 *
 * The replay is not a guess: every row of a `mutation_log` carries its field, its
 * before and after, whether it was clamped and who did it, which is exactly what an
 * entry needs. What it cannot recover is anything the old format never stored, and
 * that is a fact about the old format rather than a loss here.
 *
 * ## The state file is written, and it is still not the source
 *
 * It keeps being written because everything that reads a persona today reads it, and
 * a migration that breaks every reader on the first step is not a migration. What
 * changed is which way the arrow points: it is printed FROM the record, so editing it
 * by hand changes nothing that survives the next write. R8 is what removes it as a
 * thing anybody reads.
 */

import { writeFileSync } from "node:fs";

import type { Envelope } from "../envelopes.js";
import type { StateFile } from "../persona.js";
import { readState } from "../persona.js";
import type { Author } from "./entry.js";
import { mutate, type Decision, type MoveRequest } from "./mutate.js";
import { divergence, project, type Identity } from "./project.js";
import { writingToRecord, type RecordPorts } from "./transaction.js";

/** Who this record belongs to, read from the file it is replacing. */
function identityOf(state: StateFile): Identity {
	return {
		schemaVersion: state.schema_version,
		personaId: state.persona_id,
		personaVersion: state.persona_version,
		...(state.session_id === undefined ? {} : { sessionId: state.session_id }),
	};
}

/** What a completed adjustment did, and where it left the persona. */
export interface AdjustResult {
	readonly decision: Decision;
	/** The state file as printed from the record, after the move. */
	readonly state: StateFile;
}

/**
 * One move and who is making it.
 *
 * The author travels with the move rather than with the batch, because a tick is not
 * one hand: a decay is the runtime pulling a value toward its baseline and an
 * admitted change is the persona acting. One author for the batch would put the
 * runtime's name on the persona's changes, or the reverse.
 */
export interface Move {
	readonly author: Author;
	readonly request: MoveRequest;
}

/**
 * How a caller says what it wants moved, given where the persona actually is.
 *
 * A function and not a list, because some moves depend on the current values and
 * those can only be read correctly under the lock. A homeostatic decay is
 * `lambda * (mean - current)`: deciding it before the lock is taken computes the pull
 * from a value another writer may already have changed, so the persona is pulled
 * toward its baseline by the wrong amount and nothing says so.
 *
 * A caller whose moves do not depend on anything just ignores the argument.
 */
export type Plan = (values: Record<string, number>) => readonly Move[];

/**
 * Where an adjustment reads and writes, for an engine that is not running on a disk.
 *
 * Every one of them now belongs to `RecordPorts`, which each writer to a record shares.
 * All optional: the filesystem is the default, so a caller written before any of this
 * existed keeps working.
 */
export type AdjustPorts = RecordPorts;

/** What a batch did, in the order it did it. */
export interface AdjustAllResult {
	readonly decisions: readonly Decision[];
	/** The state file as printed from the record, after every move in the batch. */
	readonly state: StateFile;
}

/**
 * Move one coordinate and leave both the record and the printed file correct.
 *
 * The drain is awaited rather than left in flight. This is a deliberate difference
 * from a turn, where the whole point of the journal is that the person does not wait
 * for the writer: an adjustment IS the operation somebody asked for, so returning
 * before it is durable would be reporting a change that a crash could take back.
 */
export async function adjust(
	personaPath: string,
	statePath: string,
	envelopes: Record<string, Envelope>,
	author: Author,
	req: MoveRequest,
	ports: AdjustPorts = {},
): Promise<AdjustResult> {
	const { decisions, state } = await adjustAll(
		personaPath,
		statePath,
		envelopes,
		() => [{ author, request: req }],
		ports,
	);
	return { decision: decisions[0]!, state };
}

/**
 * Move several coordinates as one transaction.
 *
 * A tick is not a sequence of adjustments. It decays what has drifted and applies
 * what was admitted, and those belong to the same moment: running them one at a time
 * would take the lock, read the file, verify the chain and print the document once
 * per coordinate, and would leave a crash between two of them with a persona that
 * half-ticked. One lock, one verify, one print.
 *
 * The order of `moves` is the order they happen, and it matters: each move reads the
 * value the one before it left, which is what makes clamping compose correctly.
 * Summing deltas first and clamping once at the end is a different and wrong answer,
 * because `clamp(a + b)` is not `clamp(a) + clamp(b)`.
 */
export async function adjustAll(
	personaPath: string,
	statePath: string,
	envelopes: Record<string, Envelope>,
	plan: Plan,
	ports: AdjustPorts = {},
): Promise<AdjustAllResult> {
	const stored = (ports.state?.read ?? readState)(statePath);

	// Everything up to and including the drain happens inside, under the lock and
	// against a record opened for this write. The printing is here rather than after
	// because it has to read the entries this write just added, and outside the lock
	// they are no longer guaranteed to be the newest.
	const { decisions, printed, changed } = await writingToRecord(
		personaPath,
		statePath,
		ports,
		(record, migrated) => {
			// Planned after the migration, so the values it sees are the record's and not the
			// stored copy's. On a persona that has just migrated those agree; on one whose
			// state file somebody edited by hand they do not, and the record is the source.
			const folded0 = record.state();
			const moves = plan(folded0.ok ? folded0.state.values : {});
			const decisions = moves.map((move) => mutate(record, envelopes, move.author, move.request));

			const folded = record.state();
			if (!folded.ok) {
				// Named with the entry, because "the chain is broken" without a sequence
				// number sends somebody through the whole file. The chain stops at the first
				// problem on purpose: everything after it is suspect, so reporting the first
				// is reporting the only one that can be trusted to be real.
				throw new Error(
					`the record does not verify after the move: ${folded.problem.kind} at entry ${folded.problem.seq}`,
				);
			}

			const printed = project(folded.state, record.all(), identityOf(stored));

			return {
				decisions,
				printed,
				// A first touch is a change even with no moves: it is the migration.
				//
				// And so is a document that came out different from the one on disk. This
				// used to be moves alone, on the reasoning that rewriting the file when
				// nothing moved would touch its mtime on every idle tick for no reason.
				// That stopped being true when turns reached the record: a conversation
				// that moves no coordinate still changes the session block, so the file
				// sat one turn behind and `state rebuild` reported a persona diverged
				// from its own record until something happened to move a value.
				changed: migrated || moves.length > 0 || divergence(printed, stored).differs,
			};
		},
	);

	// Written when the document is actually different from the one on disk.
	if (changed) {
		if (ports.state) ports.state.write(statePath, printed);
		else writeFileSync(statePath, JSON.stringify(printed, null, 2) + "\n", "utf-8");
	}

	return { decisions, state: printed };
}
