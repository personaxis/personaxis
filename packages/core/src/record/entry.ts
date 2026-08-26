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

import type { DerivedState } from "./derive.js";

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
			/**
			 * The delta that was asked for, before the envelope had its say.
			 *
			 * A delta and not the position it aimed at, for two reasons that agree. It is
			 * literally what a caller asks for, so the entry records the request rather
			 * than something computed from it. And it is what `state.json` stores, so
			 * printing the file back is exact: keeping the position instead meant
			 * printing `requested - from`, and `-0.2` came back as
			 * `-0.19999999999999996`. A migration that changes the numbers slightly is
			 * not a migration, and float noise inside a hash chain is noise nobody can
			 * explain later.
			 *
			 * The two were confused for each other in both directions at once: a move of
			 * 0.02 was written down as 1.01, and a migrated delta was stored as though it
			 * were a position.
			 */
			readonly delta: number;
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
			/**
			 * What the turn cost, as the ledger charged it.
			 *
			 * On the turn and not in a counter beside it, because a cost kept anywhere
			 * else is a second number that can disagree with the entries it claims to
			 * total. A fold over closed turns IS the total, and it survives a restart
			 * without anybody persisting a running sum.
			 *
			 * Steps are always known, because the runtime counts them itself. Tokens and
			 * money are only known when a provider says, and a scripted one never does.
			 * Grouping all three made those two facts look like one, so a turn that took
			 * four steps through a provider that reports no cost had to choose between
			 * claiming it cost nothing and losing the steps.
			 *
			 * Absent tokens are different from zero tokens and must stay different: zero
			 * is a turn that cost nothing, absent is a turn nobody priced. Widening the
			 * two inner fields rather than adding a kind keeps every entry written
			 * before this valid and meaning exactly what it meant.
			 */
			readonly spent?: { readonly steps: number; readonly tokens?: number; readonly usd?: number };
	  }
	/**
	 * The situation this persona is working in.
	 *
	 * One entry and not four, because these change together: a task mode, an
	 * audience, the flags that qualify them and the memory anchors in play are one
	 * answer to "what is going on right now". Four kinds would let three of them
	 * move and the fourth stay, and nothing would say which was intended.
	 *
	 * An event and not a setting, because "who put this persona in this situation,
	 * and when" is a question an audit asks, and a settings file cannot answer it.
	 */
	| {
			readonly type: "context";
			readonly taskMode: string | null;
			readonly audience: string | null;
			readonly flags: readonly string[];
			readonly anchors: readonly string[];
	  }
	/**
	 * The persona was compiled, and to what.
	 *
	 * Its own kind rather than a field on `context`, because the author differs: a
	 * compile is the compiler's act and a context change is the operator's or the
	 * runtime's. Folding them would make one signature stand for two hands.
	 */
	| { readonly type: "compiled"; readonly hash: string }
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
	  }
	/**
	 * What the fold said as of this point, so a reader does not have to redo it.
	 *
	 * ## Why a record needs one at all
	 *
	 * Reading a persona means folding its record, and the record only grows. Measured
	 * on generated histories: 167 entries fold in about a millisecond, 10,000 in
	 * 51ms, 50,000 in 238ms. That is a read path that works today and stops working
	 * later, on a file nothing ever shortens, which is worse than one that is slow now
	 * because nobody notices until the persona nobody can afford to lose is the slow
	 * one.
	 *
	 * A reader that finds one of these folds only what comes after it.
	 *
	 * ## Why it lives in the chain and not beside it
	 *
	 * The obvious place is `state.json`, which the spec already calls a checkpoint of
	 * the log. But that file is editable, and a checkpoint somebody can edit is a
	 * checkpoint that can lie about a history it claims to summarise. Here it is
	 * hash-linked like everything else: forging one means forging the chain.
	 *
	 * It is also not a new artifact. A fourth file beside the persona would be a fourth
	 * thing to keep in step with the other three.
	 *
	 * ## It is a shortcut and never a source
	 *
	 * `state` is what folding the entries up to here produced. Nothing may be in it
	 * that is not derivable from those entries, because a reader is entitled to ignore
	 * every checkpoint and fold from zero and get the same answer. That property is
	 * what makes it safe to skip, and it is checked rather than assumed.
	 */
	| { readonly type: "checkpoint"; readonly state: DerivedState };

/**
 * Where an entry was written, as opposed to what it says.
 *
 * `at` answers when, `author` answers who, and these answer the rest of the same
 * question. They are not part of the body because none of them is a thing that
 * happened to the coordinate: the machine, the session and the tool call are facts
 * about the writing.
 *
 * They are not part of the author either, and that distinction has teeth. The same
 * person working from a laptop and a desktop is the same author, and folding the
 * machine into the author would make two people out of one. What the machine
 * actually separates is two writings, which is exactly what reconciliation needs.
 *
 * ## Why the machine has to be here rather than nowhere
 *
 * Merging two devices' histories asks whether an entry from one is the same event as
 * an entry from the other, and without the machine the answer is a guess. The spec
 * added `origin_node` for that reason and says so: concurrent edits from different
 * machines were being collapsed into one. Dropping it on the way into the record
 * would reintroduce the bug the field was cut to fix, in the layer that is supposed
 * to be the source of truth.
 *
 * ## And why inside the hash
 *
 * Everything else that says where an entry came from commits to the hash, because a
 * claim about provenance that sits outside it is a claim anybody can change. A
 * machine id that could be edited after the fact is worth less than none: it would
 * read as evidence.
 */
export interface Provenance {
	/** The machine that wrote it. What tells two devices' identical moves apart. */
	readonly node?: string;
	/** The runtime session it was written in. */
	readonly session?: string;
	/** The tool call that asked for it, when a tool did. */
	readonly toolCall?: string;
}

/**
 * The shape this build writes, stamped on every entry and inside the hash.
 *
 * A record outlives the build that wrote it, and it cannot be rewritten: that is the
 * whole point of it. So a reader meeting an entry from another shape has exactly two
 * honest options, understand it or refuse it, and it can only choose between them if
 * the entry says which shape it is.
 *
 * Written after being bitten twice in one day. What a value entry keeps in its third
 * number changed from the position that was asked for to the delta that was asked
 * for, and entries already on disk went on parsing cleanly while meaning something
 * else. Nothing was corrupt and nothing complained; the numbers were just wrong. A
 * chain sold as proof cannot have a failure mode that reads as success.
 *
 * Inside the hash for the same reason the author is: a version anybody can edit
 * afterwards is a version that can be used to make an old entry look current.
 */
export const ENTRY_VERSION = 1;

/** One entry, before it has been chained. */
export interface DraftEntry {
	/** Which shape this is. Absent means it predates versioning and is not readable. */
	readonly v: number;
	readonly at: string;
	readonly author: Author;
	readonly body: RecordBody;
	/** Absent when nothing knew any of it, which is different from empty. */
	readonly provenance?: Provenance;
}

/** One entry, chained. `hash` commits to everything above it, including `prev`. */
/**
 * The mechanism a coordinate's starting position is written under.
 *
 * Named here rather than spelled in two files, because two places deciding what
 * counts as an origin is how one of them starts counting an origin as a change. A
 * persona's declared position is not something that happened to it.
 */
export const GENESIS = "genesis";

/**
 * Whether an entry is a coordinate's starting position rather than a change to it.
 *
 * A function and not a comparison at each call site, because `Author` is a union and
 * only some of its members carry a mechanism: a human has an id and nothing else. A
 * comparison written twice is a comparison that gets the narrowing right once.
 */
/**
 * A coordinate's starting position, as an entry.
 *
 * One builder, because there were two and they had already drifted: the migration
 * called it "initialised" with a requested delta of nothing, and the runtime called
 * it "declared" with a requested delta of the whole value. Two spellings of one fact
 * is how the fact stops being one.
 *
 * The author is the runtime with the genesis mechanism, which is what
 * `isGenesis` reads and what keeps an origin out of the mutation log. A persona's
 * declared position is not something that happened to it, and printing origins into
 * the log would make every persona look as though it had been adjusted on the day it
 * was created.
 */
export function genesisEntry(field: string, value: number, at: string): DraftEntry {
	return {
		v: ENTRY_VERSION,
		at,
		author: {
			kind: "runtime",
			mechanism: GENESIS,
			reason: "the position its spec declares",
		},
		body: {
			type: "value",
			field,
			from: value,
			to: value,
			delta: 0,
			clamped: false,
			blocked: false,
			reason: "declared",
		},
	};
}

export function isGenesis(entry: { readonly author: Author }): boolean {
	return "mechanism" in entry.author && entry.author.mechanism === GENESIS;
}

export interface RecordEntry extends DraftEntry {
	readonly seq: number;
	readonly prev: string;
	readonly hash: string;
}
