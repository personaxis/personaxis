/**
 * What can be written down, and who is allowed to have written it.
 *
 * The record is not a log of what the engine felt like mentioning. It is the state
 * itself: everything the persona is at any moment is a fold over these entries, so
 * a thing that is not here did not happen, and a thing that is here cannot be
 * unhappened.
 *
 * ## Nothing enters without saying who put it there
 *
 * This is the invariant the study found four separate times, in two codebases, none
 * of which was looking for it. A crashed turn gets closed with synthetic results,
 * and the model did not write them. A repetition guard appends a reminder, and an
 * unlabelled one renders as a real request from the person. A settlement notice
 * carries a different provenance kind so a transcript never credits a child with
 * words the runtime wrote. An advisory trace is a side channel and never the
 * message table.
 *
 * In an ordinary log an unattributed line is confusing. In a chain we sell as proof,
 * a line that looks like the person's and was written by a component is **a forged
 * record**, and it cannot be corrected afterwards because nothing here can be
 * edited. So `author` is required and has no default.
 *
 * The old mutation log defaulted a missing actor to `human-operator`, which is
 * precisely the shape of that bug: an entry written by a component claiming a person
 * did it. There is no default here, and `verify` rejects an entry without an author.
 *
 * ## The provider's material does not live here
 *
 * Reasoning signatures and encrypted blocks are sealed to whoever issued them:
 * replaying one against a different endpoint fails deterministically, and any
 * upstream edit invalidates the signature. A runtime that can rewrite history
 * recovers from that. We cannot, so storing it would leave us choosing between
 * mutating the immutable and carrying blocks nobody can decrypt.
 *
 * So the record keeps **the text and a reference with its issuer stamped**, and
 * whether to replay the artifact is a decision for the transport layer rather than a
 * property of the record.
 */

/**
 * Who wrote an entry.
 *
 * Closed, and every case carries an identity rather than a bare label. "Runtime" is
 * the one that would otherwise be used as a shrug, so it requires a `reason`: the
 * runtime writing something is exactly the case where a reader six months later
 * needs to know which part of it and why.
 */
export type Author =
	/** A person, named. */
	| { readonly kind: "human"; readonly id: string }
	/** The persona itself, acting. */
	| { readonly kind: "persona"; readonly id: string }
	/** A mounted component, by the name the kernel knows it by. */
	| { readonly kind: "component"; readonly name: string }
	/** The runtime, doing something no one asked for. Always says which and why. */
	| { readonly kind: "runtime"; readonly mechanism: string; readonly reason: string };

/** How an author reads in a report, and how two are compared. */
export function authorId(author: Author): string {
	switch (author.kind) {
		case "human":
			return `human:${author.id}`;
		case "persona":
			return `persona:${author.id}`;
		case "component":
			return `component:${author.name}`;
		case "runtime":
			return `runtime:${author.mechanism}`;
	}
}

/**
 * A reference to something a provider produced that we deliberately do not store.
 *
 * `issuer` is not decoration. The same blob replayed against a different endpoint
 * is rejected, so a consumer has to be able to ask "was this ours" before trying,
 * and it must be able to ask that without having the blob.
 */
export interface ProviderArtifact {
	/** Which endpoint or provider sealed it. */
	readonly issuer: string;
	/** What kind of thing it is: a reasoning signature, an encrypted block, an id. */
	readonly kind: string;
	/** Where it can be fetched from, in whatever store holds provider material. */
	readonly ref: string;
}

/** The things that can happen, each one a fact rather than a notification. */
export type RecordBody =
	/**
	 * A declared coordinate moved, or was refused. Both are facts.
	 *
	 * `to` is what the value became. Deriving reads this and nothing else, which is
	 * what lets state be a fold rather than a second copy that can disagree.
	 */
	| {
			readonly type: "value";
			readonly field: string;
			readonly from: number;
			readonly to: number;
			readonly requested: number;
			readonly clamped: boolean;
			readonly blocked: boolean;
			readonly reason: string;
	  }
	/** A component came up, went away, or reloaded. Carries the epoch it resolved to. */
	| {
			readonly type: "lifecycle";
			readonly component: string;
			readonly from: string;
			readonly to: string;
			readonly epoch?: string;
			readonly reason?: string;
	  }
	/** A turn opened. Everything until its close belongs to it. */
	| { readonly type: "turn-open"; readonly turn: string; readonly prompt: string }
	/**
	 * A turn closed, and how.
	 *
	 * `synthetic` marks a close the runtime wrote because the turn never got to
	 * write its own. A crashed turn is closed, never truncated: truncating leaves a
	 * transcript a provider will reject, and the synthetic close is what keeps a
	 * resumed conversation valid. It is only honest because the author says who
	 * wrote it.
	 */
	| {
			readonly type: "turn-close";
			readonly turn: string;
			readonly outcome: string;
			readonly synthetic: boolean;
	  }
	/** Something the model said, with any provider material left outside by reference. */
	| {
			readonly type: "message";
			readonly turn: string;
			readonly role: "assistant" | "user" | "tool";
			readonly text: string;
			readonly artifacts?: readonly ProviderArtifact[];
	  }
	/** A tool was asked for, and what the gate decided about it. */
	| {
			readonly type: "call";
			readonly turn: string;
			readonly callId: string;
			readonly tool: string;
			readonly verdict: "allowed" | "denied";
			readonly reason?: string;
	  }
	/**
	 * Which tools were put in front of the model on one request, and why.
	 *
	 * The set a model can see decides what it can try, so it is a fact about what the
	 * persona could reach, not an implementation detail. Both references recompute it
	 * and keep it in a process global, which means the question "what could this agent
	 * try on Tuesday at three" has no answer once the process is gone.
	 *
	 * `reason` is what makes the entry useful rather than a list. A tool absent
	 * because the persona is read-only, absent because a probe failed, and absent
	 * because nobody installed it are three different situations that a bare list
	 * renders identically.
	 */
	| {
			readonly type: "surface";
			readonly turn: string;
			readonly tools: readonly string[];
			readonly reason: string;
	  }
	/** Something went wrong, with a code so it can be routed and not just read. */
	| {
			readonly type: "failure";
			readonly code: string;
			readonly message: string;
			readonly subject?: string;
	  };

/** One entry, before it has been chained. */
export interface DraftEntry {
	readonly at: string;
	readonly author: Author;
	readonly body: RecordBody;
}

/** One entry, chained. `hash` commits to everything above it, including `prev`. */
export interface RecordEntry extends DraftEntry {
	readonly seq: number;
	readonly prev: string;
	readonly hash: string;
}
