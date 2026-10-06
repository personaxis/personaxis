/**
 * The one correspondence between an author and the word the state file uses for it.
 *
 * There were two, in two files, pointing opposite ways. `bridge.ts` turned a stored
 * `actor` into an `Author` when migrating, and `project.ts` turned an `Author` back
 * into a string when printing. Two mappings for one correspondence is one mapping
 * more than there are facts, and they drifted exactly as that always drifts: the
 * migration was faithful, the projection was not, and the projection was the half
 * that wrote to disk.
 *
 * Measured on a real persona: 147 rows went in as `actor-llm` and `runtime-context`
 * and came back out as `self` and `runtime`. Three of the five words became strings
 * that are not in the schema's enum at all, so every row of a projected file failed
 * the JSON Schema this project publishes. A cast to `MutationLogEntry` was what kept
 * the compiler from saying so.
 *
 * ## Why the file's vocabulary is the smaller one, and what happens at its edge
 *
 * `Author` says who acted and, when it was the runtime, which mechanism and why. The
 * file has one string from a closed list of five that mixes the two questions
 * together. So the migration direction is lossless and the printing direction is a
 * narrowing, and a narrowing has an edge: a component, or a runtime mechanism the
 * five words never anticipated, has no word here.
 *
 * At that edge there are three things this could do, and two of them are worse than
 * they look. Printing the nearest word attributes a mutation to a subsystem that did
 * not make it, which is the forgery the record exists to prevent, committed by the
 * printer. Printing the author's own vocabulary is what it used to do, and it
 * produced files that fail the published schema. So it refuses, and it refuses
 * **when the entry is written** rather than when the file is printed: a persona
 * whose record already holds an unprintable entry would otherwise be one that can
 * never write its state file again.
 *
 * The refusal is temporary by construction. It exists because `state.json` is still
 * being projected; R8 removes the file and the constraint goes with it.
 */

import type { MutationLogEntry } from "../persona.js";
import type { Author } from "./entry.js";

/** The word the state schema uses for a mutation's origin. */
export type Actor = MutationLogEntry["actor"];

/**
 * The runtime mechanisms the file's vocabulary has a word for.
 *
 * Named rather than spelled at each site, because a writer that passes
 * `"homeostasis"` and a printer that looks for `"decay"` is the same class of drift
 * this file exists to end, one level down.
 */
export const MECHANISM = {
	/** A declared half-life pulled a value toward its mean. */
	decay: "homeostasis",
	/** The active context changed what a coordinate should be. */
	context: "context",
	/** An evaluation corrected a value. */
	judge: "judge",
} as const;

/**
 * The mechanism prefix for a stored word this build does not know.
 *
 * The word follows it, so the round trip is reversible by construction rather than
 * by parsing prose. A file that used a sixth actor was already invalid against the
 * published schema; printing our own word over it would launder somebody's anomaly
 * into a fact, and refusing would leave them unable to write the file at all. It
 * goes back out as it came in, and the invalidity stays theirs and visible.
 */
export const UNRECOGNISED = "unrecognised-actor:";

/**
 * How a person the runtime cannot name is identified.
 *
 * A real person, whose name we do not have. Naming them would be inventing an
 * identity; leaving the author out would make the entry unverifiable. Exported
 * because a live turn attributes its asker the same way a migrated row does, and two
 * spellings of one identity is the drift this file exists to end.
 */
export const UNNAMED_OPERATOR = "unattributed-operator";

/**
 * How the persona a record belongs to is identified inside it.
 *
 * Not its canonical id, and the reason is that the id would be a second name for
 * something the file already says: a record lives beside one persona and describes
 * that one. Two spellings of one actor in one file is the drift this file exists to
 * end, and it would have arrived the moment turns were recorded, because every
 * coordinate entry already says `self` and a turn would have said `clio`.
 *
 * A name is not lost by this. Another persona's id is written when ANOTHER persona is
 * the author, which is what makes a delegation legible: `self` means the owner of this
 * record and anything else means somebody else.
 *
 * It also survives a rename. An identity that changes when a display name changes is
 * an identity a hash chain cannot rely on.
 */
export const SELF = "self";

/**
 * The author a stored `actor` stands for.
 *
 * `human-operator` becomes an unnamed human rather than being invented into a real
 * identity. A migration that guessed a name would put a person's name on entries
 * they may never have written.
 *
 * A word outside the five gets an author that SAYS it is unrecognised and carries
 * the original. Falling off the end returned `undefined`, and an entry without an
 * author does not verify, so one strange word made a whole chain unreadable and the
 * failure pointed at the chain instead of at the word.
 */
export function authorOf(actor: Actor | string): Author {
	switch (actor) {
		case "human-operator":
			return { kind: "human", id: UNNAMED_OPERATOR };
		case "actor-llm":
			return { kind: "persona", id: SELF };
		case "runtime-decay":
			return {
				kind: "runtime",
				mechanism: MECHANISM.decay,
				reason: "declared half-life pulled the value toward its mean",
			};
		case "runtime-context":
			return {
				kind: "runtime",
				mechanism: MECHANISM.context,
				reason: "the active context changed what this coordinate should be",
			};
		case "judge-correction":
			return {
				kind: "runtime",
				mechanism: MECHANISM.judge,
				reason: "an evaluation corrected the value",
			};
		default:
			return {
				kind: "runtime",
				mechanism: `${UNRECOGNISED}${String(actor)}`,
				reason: `the state file attributed this to "${String(actor)}", which is not one this build knows`,
			};
	}
}

/**
 * Whether our own writers may attribute a coordinate entry to this author.
 *
 * A different question from "what word does this print as", and separated because
 * conflating them is what produced the bug. Printing has to cope with whatever a
 * migrated file contained; writing does not, and an author with no word is a mistake
 * in a writer that should be reported to whoever made it.
 */
export function isWritableAuthor(author: Author): boolean {
	const word = actorFor(author);
	return word !== undefined && !word.startsWith(UNRECOGNISED);
}

/**
 * The word for an author, or `undefined` when there is none to print.
 *
 * Returns rather than throws because the two callers mean different things by a
 * missing word: a writer must refuse, and a printer has been handed an entry that
 * only a hand-written record could contain.
 *
 * A preserved foreign word comes back out as itself. That is why the return is a
 * string rather than the enum: a valid file holds one of five, and this also has to
 * describe what an invalid one held.
 */
export function actorFor(author: Author): string | undefined {
	switch (author.kind) {
		case "human":
			return "human-operator";
		case "persona":
			return "actor-llm";
		case "component":
			// A mounted component is a thing the five words predate entirely.
			return undefined;
		case "runtime":
			switch (author.mechanism) {
				case MECHANISM.decay:
					return "runtime-decay";
				case MECHANISM.context:
					return "runtime-context";
				case MECHANISM.judge:
					return "judge-correction";
				default:
					// The word a migrated file used, given back unchanged. Anything else
					// is a mechanism no writer of a coordinate entry should have used.
					return author.mechanism.startsWith(UNRECOGNISED)
						? author.mechanism.slice(UNRECOGNISED.length)
						: undefined;
			}
	}
}

/**
 * How an author reads when explaining why it cannot be written down.
 *
 * Spelled out rather than `JSON.stringify`d, because the person reading this is
 * looking for which writer passed it, and `{"kind":"component","name":"x"}` sends
 * them to the wrong question.
 */
export function describeAuthor(author: Author): string {
	switch (author.kind) {
		case "human":
			return `human "${author.id}"`;
		case "persona":
			return `persona "${author.id}"`;
		case "component":
			return `component "${author.name}"`;
		case "runtime":
			return `runtime mechanism "${author.mechanism}"`;
	}
}

/**
 * The word to print for an author, refusing when there is none at all.
 *
 * The return is typed as the schema's enum and the value may be a preserved foreign
 * word, and that gap is the honest description of the situation rather than a hole:
 * a valid file holds one of five, and a file this migrated from may have held
 * something else, which it gets back. The narrowing is here, once, named, instead of
 * a cast over the whole row that hid three different ones at the same time.
 *
 * It can only refuse for a record written by hand, because `mutate` will not write a
 * coordinate entry whose author has no word and `replayStateFile` preserves whatever
 * the file used. The message names the author, since "cannot project" on its own
 * sends somebody through the whole record looking for it.
 */
export function requireActor(author: Author): Actor {
	const actor = actorFor(author);
	if (actor === undefined) {
		throw new Error(
			`${describeAuthor(author)} has no word in the state file's actor vocabulary ` +
				"(actor-llm, runtime-decay, runtime-context, human-operator, judge-correction), " +
				"so this entry cannot be printed into state.json. Give the mechanism one of the " +
				"names in MECHANISM, or wait for R8 to retire the file.",
		);
	}
	return actor as Actor;
}
