/**
 * Writing a compaction down, and measuring whether it cost the persona anything.
 *
 * Two halves that only exist because of the two things we have and the references do
 * not: a record that cannot be edited, and a drift metric against a declared envelope.
 *
 * ## A compaction is an entry, not an edit
 *
 * Theirs mutates: rows already written and already sent are rewritten in place. Almost
 * every one of their fourteen thousand lines follows from that, and so does the class of
 * failure they kept finding, including the compaction that grew a transcript from 379K
 * to 687K tokens and the rejection that nobody counted, which left the same transcript
 * being retried on every later turn.
 *
 * Here the record is untouched. What gets written is what the compaction **decided**,
 * with its author, and what the model sees is a projection over the record. That means
 * two things worth saying plainly. A compaction can be audited afterwards, because the
 * plan is in the chain next to everything else. And a compaction can be *undone* by
 * ignoring it, because nothing it touched was destroyed.
 *
 * ## Whether it cost the persona anything is a question only we can ask
 *
 * Everybody can ask whether the transcript shrank. Nobody else can ask whether the
 * persona is still where it was, because that needs an envelope declared before the run
 * and a metric against it.
 *
 * This is not a nicety. An agent that compresses itself until it forgets who it is
 * explains a large part of the drift the industry measures and cannot correct. Having
 * the instrument is what turns our rule from a design preference into a claim somebody
 * can check, and the honest form of the claim is: **compaction must not move the
 * persona**, and here is the number.
 */

import { driftReport, type DriftReport } from "../math/drift.js";
import type { Envelope as CoordinateEnvelope } from "../envelopes.js";
import type { Author, RecordBody } from "../record/entry.js";
import type { CompactionPlan } from "./service.js";

/** The author every compaction entry carries. */
export function compactionAuthor(reason: string): Author {
	return { kind: "runtime", mechanism: "compaction", reason };
}

/**
 * The entry a compaction writes.
 *
 * A `failure` body rather than a type of its own, deliberately, and worth explaining
 * because it looks like a shortcut. A compaction is not a thing that happened to the
 * persona; it is a thing that happened to what the persona will be shown. Giving it a
 * first-class body would put it in the fold, where it would look like state, and it is
 * not state. What it is, is a note in the chain saying what was decided and by whom.
 */
export function compactionEntry(plan: CompactionPlan, why: string): RecordBody {
	const parts = [
		`pruned ${plan.pruned.length}`,
		`summarised ${plan.summarised.length}`,
		`kept ${plan.kept.length}`,
		`${plan.before} to ${plan.after}`,
	];
	if (plan.anomaly) {
		parts.push(
			`protected region at ${plan.anomaly.weight} against a ceiling of ${plan.anomaly.ceiling}`,
		);
	}
	return {
		type: "failure",
		code: plan.anomaly ? "compaction_anomaly" : "compaction",
		message: `${why}: ${parts.join(", ")}`,
		subject: "compaction",
	};
}

/** What a compaction did to the persona's position, if anything. */
export interface DriftDelta {
	readonly before: number;
	readonly after: number;
	/** Positive means the persona moved further from where it declared it sits. */
	readonly moved: number;
	/** Coordinates whose drift went up, which is the list worth looking at. */
	readonly worsened: readonly string[];
	/** True when nothing moved, which is what the rule says should always be the case. */
	readonly clean: boolean;
}

/**
 * Measures the persona before and after, from two derived states.
 *
 * Takes states rather than computing them, because deriving is the record's job and a
 * measurement that derived its own inputs could disagree with what the record says
 * happened. Same reason the gate does not estimate its own effects.
 *
 * The tolerance is float noise and nothing more. A real move shows up far above it, and
 * a threshold generous enough to swallow a real move is a threshold that makes the
 * measurement useless, which is how a guard becomes dead code.
 */
export function driftAcross(
	before: Record<string, number>,
	after: Record<string, number>,
	envelopes: Record<string, CoordinateEnvelope>,
	options: { readonly maxStepDelta?: number; readonly thresholds?: Record<string, number> } = {},
): DriftDelta {
	const maxStepDelta = options.maxStepDelta ?? 1;
	const first = driftReport({
		values: before,
		envelopes,
		maxStepDelta,
		...(options.thresholds ? { thresholds: options.thresholds } : {}),
	});
	const second = driftReport({
		values: after,
		envelopes,
		maxStepDelta,
		...(options.thresholds ? { thresholds: options.thresholds } : {}),
	});

	const worsened = coordinatesThatWorsened(first, second);
	const moved = second.global - first.global;
	return {
		before: first.global,
		after: second.global,
		moved,
		worsened,
		clean: Math.abs(moved) <= 1e-9 && worsened.length === 0,
	};
}

function coordinatesThatWorsened(before: DriftReport, after: DriftReport): string[] {
	const was = new Map(before.coordinates.map((entry) => [entry.field, entry.drift] as const));
	const worsened: string[] = [];
	for (const entry of after.coordinates) {
		const previous = was.get(entry.field);
		if (previous === undefined) continue;
		if (entry.drift - previous > 1e-9) worsened.push(entry.field);
	}
	return worsened;
}
