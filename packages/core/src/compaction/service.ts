/**
 * Making a conversation shorter without making the persona somebody else.
 *
 * The reference algorithm is good and most of it is taken whole: prune what can be
 * pruned without paying for a model call, measure again, and only summarise if the
 * pressure is still there; compress the middle and leave a recent tail; refuse a
 * summary that does not shrink its source.
 *
 * Two things are ours, and both come out of having an envelope.
 *
 * ## What is protected is read from the layers, not from a list
 *
 * Theirs protects a head by **position**, and their own parameter for it decays to zero
 * after the first pass, because keeping it fossilised the first turns: they were
 * recopied into every child session, never summarised, and the head grew without bound.
 * They were right to make it decay, and the decay is the tell. Position is a proxy for
 * importance and a bad one.
 *
 * Identity, character and hard limits are not early, they are **declared**. So the
 * incompressible set is a consequence of what the persona said it is, and it is
 * re-emitted rather than preserved in place, which is why it cannot fossilise the way
 * a protected prefix does.
 *
 * And it lives here rather than in a prompt, because a sentence in a prompt is
 * something a model can drop exactly when the context is tight, which is exactly when
 * this matters.
 *
 * ## Protected does not mean unbounded
 *
 * Their sharpest warning, in one line: turn boundaries **do not protect** old steps
 * inside a runaway turn. Protecting by declared layer opens the same trap from another
 * side. If the protected region could grow without a ceiling, we would have invented a
 * place where context grows and nothing may touch it.
 *
 * So protection says **what** survives, never **how much**. A protected region
 * approaching its own ceiling is an anomaly to report, not a cupboard.
 *
 * ## Compaction is an entry, not an edit
 *
 * Almost all of the reference's fourteen thousand lines exist because compacting edits
 * rows already written and already sent: a commit fence, a growth guard at the commit
 * site, a mechanical rescue, frozen wire prefixes, persistence markers removed by hand.
 * None of those failure classes survives without the edit. Here the record stays whole
 * and a compaction is a derived view with its own provenance entry, so what is sent to
 * the model is a projection and the chain is untouched.
 */

/** What a piece of the conversation is, for the purposes of deciding its fate. */
export interface Unit {
	readonly id: string;
	/** Which declared layer it belongs to, when it belongs to one. */
	readonly layer?: string;
	/** Roughly what it costs. Cheap and consistent beats accurate and slow. */
	readonly weight: number;
	/** Whether it can be pruned without a model call: a big tool result, a dump. */
	readonly prunable: boolean;
	/** Whether it is part of an open pair that must not be split. */
	readonly pairId?: string;
}

export interface Envelope {
	/** Layers that are never compacted, read from the persona rather than configured. */
	readonly protectedLayers: readonly string[];
	/**
	 * The most the protected region may weigh before it is an anomaly.
	 *
	 * Not a limit that trims it, a threshold that reports it. Trimming would put the
	 * decision about what the persona is inside a size calculation.
	 */
	readonly protectedCeiling: number;
}

export interface Pressure {
	/** What the request currently weighs. */
	readonly weight: number;
	/** The weight at which compaction is needed. */
	readonly threshold: number;
}

/** What a compaction did, in enough detail for the record to carry it. */
export interface CompactionPlan {
	/** Units kept exactly as they are. */
	readonly kept: readonly string[];
	/** Units pruned without a model call. */
	readonly pruned: readonly string[];
	/** Units the summary replaces. Empty when pruning was enough. */
	readonly summarised: readonly string[];
	readonly before: number;
	readonly after: number;
	/** Present when the protected region is over its ceiling. */
	readonly anomaly?: Anomaly;
}

/**
 * Something worth telling somebody about, separate from what the plan does.
 *
 * Its own type because it travels on two results, and the second is the one that
 * matters: when the protected region is over its ceiling **and** is the reason nothing
 * can be compacted, an "incompressible" answer with no anomaly sends the reader looking
 * at the conversation when the conversation is not the problem.
 */
export interface Anomaly {
	readonly kind: "protected_over_ceiling";
	readonly weight: number;
	readonly ceiling: number;
}

export type CompactionResult =
	| { readonly ok: true; readonly plan: CompactionPlan }
	/** Nothing to do, which is a normal answer and not a failure. */
	| { readonly ok: false; readonly why: "no_pressure" }
	/**
	 * There is pressure and nothing left that may be touched.
	 *
	 * Carries the anomaly when there is one, because this is precisely the case where
	 * the protected region being oversized is the explanation rather than a footnote.
	 */
	| {
			readonly ok: false;
			readonly why: "incompressible";
			readonly protectedWeight: number;
			readonly anomaly?: Anomaly;
	  };

function isProtected(unit: Unit, envelope: Envelope): boolean {
	if (unit.layer === undefined) return false;
	return envelope.protectedLayers.some(
		(layer) => unit.layer === layer || unit.layer!.startsWith(`${layer}.`),
	);
}

function weigh(units: readonly Unit[]): number {
	return units.reduce((total, unit) => total + unit.weight, 0);
}

/**
 * Works out what to do, and does none of it.
 *
 * Returning a plan rather than a new conversation is what keeps this testable against
 * the property that matters, and what lets the caller write the plan into the record
 * before anything acts on it.
 *
 * The ladder is theirs and is taken whole, because it is right and because the cheap
 * step is the one everybody skips: **prune first, weigh again, and only summarise if
 * the pressure is still there**. Summarising costs a model call; pruning costs nothing.
 */
export function plan(
	units: readonly Unit[],
	envelope: Envelope,
	pressure: Pressure,
	options: { readonly tailWeight?: number } = {},
): CompactionResult {
	const before = pressure.weight;
	if (before <= pressure.threshold) return { ok: false, why: "no_pressure" };

	const guarded = units.filter((unit) => isProtected(unit, envelope));
	const protectedWeight = weigh(guarded);
	const anomaly =
		protectedWeight > envelope.protectedCeiling
			? {
					kind: "protected_over_ceiling" as const,
					weight: protectedWeight,
					ceiling: envelope.protectedCeiling,
				}
			: undefined;

	const movable = units.filter((unit) => !isProtected(unit, envelope));

	// Step one: prune, which costs nothing. Only the oldest prunable units, and only
	// as many as it takes.
	const pruned: string[] = [];
	let weight = before;
	for (const unit of movable) {
		if (weight <= pressure.threshold) break;
		if (!unit.prunable) continue;
		pruned.push(unit.id);
		weight -= unit.weight;
	}

	if (weight <= pressure.threshold) {
		return {
			ok: true,
			plan: {
				kept: units.filter((unit) => !pruned.includes(unit.id)).map((unit) => unit.id),
				pruned,
				summarised: [],
				before,
				after: weight,
				...(anomaly ? { anomaly } : {}),
			},
		};
	}

	// Step two: summarise the middle. The tail is kept by weight rather than by count,
	// because a handful of very large units is exactly the case a count misses.
	const tailWeight = options.tailWeight ?? Math.max(0, Math.floor(pressure.threshold * 0.25));
	const remaining = movable.filter((unit) => !pruned.includes(unit.id));

	const tail = new Set<string>();
	let tailSoFar = 0;
	for (let index = remaining.length - 1; index >= 0; index -= 1) {
		const unit = remaining[index]!;
		if (tailSoFar + unit.weight > tailWeight) break;
		tail.add(unit.id);
		tailSoFar += unit.weight;
	}

	// A pair is never split. Compacting half of a call-and-result leaves a request with
	// no answer, which the provider rejects and which reads as data loss to everyone
	// else.
	const pairsInTail = new Set(
		remaining.filter((unit) => tail.has(unit.id) && unit.pairId).map((unit) => unit.pairId!),
	);
	for (const unit of remaining) {
		if (unit.pairId && pairsInTail.has(unit.pairId)) tail.add(unit.id);
	}

	const summarised = remaining.filter((unit) => !tail.has(unit.id)).map((unit) => unit.id);
	if (summarised.length === 0) {
		// Everything left is protected or is the tail, and the pressure is still there.
		// Saying so beats returning a plan that changes nothing, which is the loop the
		// reference fell into: a no-op that left the gate saying compaction was needed,
		// so every later turn fired another one.
		return {
			ok: false,
			why: "incompressible",
			protectedWeight,
			...(anomaly ? { anomaly } : {}),
		};
	}

	const summarisedWeight = weigh(remaining.filter((unit) => summarised.includes(unit.id)));
	// A summary is assumed to cost a tenth of what it replaces. Whoever produces one
	// must check it actually shrank; this is a plan, and the check belongs where the
	// text exists.
	const after = weight - summarisedWeight + Math.ceil(summarisedWeight * 0.1);

	return {
		ok: true,
		plan: {
			kept: units
				.filter((unit) => !pruned.includes(unit.id) && !summarised.includes(unit.id))
				.map((unit) => unit.id),
			pruned,
			summarised,
			before,
			after,
			...(anomaly ? { anomaly } : {}),
		},
	};
}

/**
 * Whether a produced summary may be committed.
 *
 * Refusing one that does not shrink its source is theirs and is adopted directly. The
 * case they measured is the one nobody predicts: a compaction that took a transcript
 * from 379K to 687K tokens, because the generated summary plus the reasoning it kept
 * outweighed what it replaced.
 */
export function summaryAcceptable(replacedWeight: number, summaryWeight: number): boolean {
	return summaryWeight < replacedWeight;
}
