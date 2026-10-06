/**
 * Which message a compaction plan is talking about.
 *
 * `CompactionPlan` names what it kept, pruned and summarised by unit id, and the loop
 * carries an array of `ChatMessage` with no id on it. That gap is the only thing that
 * stood between a compaction and the record, and it is worth saying why the three
 * obvious ways to close it are all wrong before saying what is done instead.
 *
 * **A generated id is a false id.** Handing each message a fresh uuid at compaction
 * time makes the plan well formed and makes the record say something nobody can check:
 * a reader holding the transcript cannot tell whether `u7f3a` is the message they are
 * looking at or a name invented so the entry would validate. An id in a record has to
 * be checkable by whoever reads it, or it is decoration.
 *
 * **A position is not an identity.** Numbering by index is checkable and stops being
 * true the moment it is used: compaction is precisely the operation that changes every
 * index after the cut, so message 14 in the plan is message 3 in the transcript the
 * plan produced. The id would not survive the event it exists to document, and two
 * plans about the same conversation could not be laid beside each other.
 *
 * **A body of its own is two formats for one fact.** Skipping `compactionEntry` and
 * writing a bespoke entry avoids the ids and buys a second spelling of a compaction in
 * the same chain, which is the divergence this repository spends most of its rules
 * preventing.
 *
 * ## So the id is the message
 *
 * A unit id is a digest of the whole message, over the same canonical bytes the record
 * chain uses. That gets all three properties at once and asks nobody to remember
 * anything. It is checkable, because a reader with the transcript recomputes it. It is
 * stable across compactions, because it depends on the message and not on where the
 * message sits. And it costs nothing at the twelve places the loop appends, because
 * there is nothing to assign: a message has an identity by being what it is.
 *
 * ## Two identical messages have one id, and that is the honest answer
 *
 * If a transcript says the same thing twice, byte for byte, the two occurrences share
 * an id. The alternative is disambiguating by occurrence, which is a position wearing a
 * different hat and fails for the same reason.
 *
 * Nothing is lost by it. `kept`, `pruned` and `summarised` are lists, not sets, so a
 * duplicate is written twice and the counts stay true. A plan where the same id appears
 * under `kept` and under `summarised` is not ambiguous either: it says that content was
 * in the transcript twice and the two copies met different fates, which is exactly what
 * happened.
 */

import { canonical } from "../record/chain.js";
import { createHash } from "node:crypto";
import type { ChatMessage } from "../tool-calling.js";
import type { CompactionPlan } from "./service.js";

/**
 * How much of the digest is kept.
 *
 * Long enough that a collision between two DIFFERENT messages is not a thing that
 * happens, short enough that a plan naming thirty units is still something a person can
 * read. This is a label inside an entry whose integrity the chain already covers, not a
 * commitment anybody defends on its own, so the whole digest would be length for the
 * sake of it.
 */
const ID_LENGTH = 16;

/**
 * The identity of one message.
 *
 * Over the canonical bytes rather than `JSON.stringify`, for the reason the chain gives
 * for the same choice: key order is a fact about how an object was built, and two
 * processes that built the same message differently would otherwise disagree about what
 * it is called. That matters here as soon as a transcript crosses a wire.
 *
 * Not exported, and that is a decision rather than an oversight. "A reader can check
 * this" is a property of the id being a function of the message, and it holds whether
 * or not a helper is on the package surface. Publishing one whose only caller is its own
 * test is the shape the connectedness ratchet exists to catch, so it goes public the day
 * something outside this file recomputes an id, and not before.
 */
function unitId(message: ChatMessage): string {
	const bytes = JSON.stringify(canonical(message));
	return `u${createHash("sha256").update(bytes).digest("hex").slice(0, ID_LENGTH)}`;
}

/** What a compaction decided, in messages, before it is said in ids. */
export interface CompactionParts {
	/** Eligible messages the compaction left alone. */
	readonly kept: readonly ChatMessage[];
	/** Eligible messages dropped without a model call. */
	readonly pruned?: readonly ChatMessage[];
	/** Eligible messages the summary now stands for. */
	readonly summarised: readonly ChatMessage[];
	readonly before: number;
	readonly after: number;
}

/**
 * The plan a compaction writes down, from the messages it actually moved.
 *
 * **Eligible** is doing real work in those field names. The leading system block is not
 * here, and leaving it out is a decision rather than an oversight: compaction never
 * touches it, so counting it under `kept` would inflate the number with a block that
 * was never at risk, and make a plan look like it protected something when it had
 * simply not been asked. `kept` means offered up and survived.
 *
 * The summary and the pinned task state are absent for the mirror-image reason. They
 * are what the compaction PRODUCED, and a plan describes what it was given.
 */
export function compactionPlan(parts: CompactionParts): CompactionPlan {
	return {
		kept: parts.kept.map(unitId),
		pruned: (parts.pruned ?? []).map(unitId),
		summarised: parts.summarised.map(unitId),
		before: parts.before,
		after: parts.after,
	};
}
