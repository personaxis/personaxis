/**
 * The conversation a loop borrows, and gives back.
 *
 * `TurnOutcome` deliberately does not carry the transcript. A scripted provider has no
 * messages, so putting them in the result would make the seam describe the shape of one
 * particular loop, which is the thing the seam exists to stop. But the REPL needs
 * continuity across turns, and it had been getting it by reaching past the seam and
 * reading `PersonaAgent.lastMessages`.
 *
 * So the conversation is neither a result nor the loop's property. It belongs to the
 * session, which lends it to whatever runs the turn: the loop reads what was said and
 * writes back what it now is. A provider that keeps no transcript never touches it, and
 * the continuity it cannot offer is honestly absent rather than silently empty.
 *
 * ## Why this is not the record
 *
 * The record holds what was said, attributed, in a chain nobody can edit. It is not the
 * transcript a model can be handed, and it is not trying to be, for two reasons that
 * were checked rather than assumed.
 *
 * A provider's material is deliberately outside the record: reasoning signatures and
 * encrypted blocks are sealed to whoever issued them, so a chain that cannot be edited
 * is the wrong place to keep something that stops being valid (see `ProviderArtifact`
 * in `record/entry.ts`). Some providers reject a conversation that came back without
 * them.
 *
 * And the record does not store a tool call's arguments. Its `call` body keeps who
 * asked, which tool, and what the gate decided, because those are the audit facts; the
 * arguments are the provider's request shape. A transcript rebuilt from it would have
 * an assistant turn that called a tool, no record of what it called it with, and a tool
 * result with nothing to attach to.
 *
 * So the two do different jobs on purpose. The record is what the persona can be held
 * to. This is what the next request is built from, and it is the provider's shape all
 * the way down.
 *
 * ## It is a projection, and the record is not
 *
 * `compactMessages` replaces older turns with a summary once the window fills, so what
 * a session carries is smaller than what was said. That is not a discrepancy to fix.
 * The record keeps everything, because it is append-only and nothing about it has to
 * fit in a context window; the conversation keeps what fits, because a request that
 * does not fit is a request that fails.
 */

import type { ChatMessage } from "../tool-calling.js";

/**
 * Where a session keeps what has been said, for whoever runs the next turn.
 *
 * Two methods rather than a mutable array, because the array a caller holds and the
 * array a provider appends to are the same object only by luck, and a seam that
 * depends on luck is a seam that breaks the first time somebody copies a list.
 */
export interface Conversation {
	/** What has been said so far, without the system message. */
	read(): readonly ChatMessage[];
	/** What it is now. Called by whatever ran the turn, with its own transcript. */
	write(messages: readonly ChatMessage[]): void;
}

/**
 * A conversation held in memory, for a caller that has nowhere else to keep one.
 *
 * The system message is dropped on the way in rather than on the way out. It is built
 * fresh for every request from the persona's current identity, so carrying an old one
 * forward would hand the model a description of who this persona used to be.
 */
export function inMemoryConversation(initial: readonly ChatMessage[] = []): Conversation {
	let held: readonly ChatMessage[] = initial.filter((message) => message.role !== "system");

	return {
		read: () => held,
		write: (messages) => {
			held = messages.filter((message) => message.role !== "system");
		},
	};
}
