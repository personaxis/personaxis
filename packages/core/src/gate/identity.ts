/**
 * The second axis: does this call leave me being who I said I am?
 *
 * Every runtime asks whether a call may happen. Ours asks that **and** whether the
 * call is compatible with the persona's declared envelope. Nobody else can ask the
 * second question, and not because they did not think of it: they have nothing to ask
 * it against. An envelope is declared before the agent starts, with a range per
 * coordinate, bands inside that range, and a governance posture per layer saying what
 * a crossing means. Without that, "is this still you" has no referent.
 *
 * ## What the axis actually weighs
 *
 * A call arrives carrying its projected effect on declared coordinates, when anything
 * knows them. Three outcomes, in order of severity:
 *
 *   - **Outside the envelope.** The coordinate would leave the range the persona
 *     declared. This is not drift, it is a different persona, and no posture below
 *     `autonomous` lets it through.
 *   - **Crossing a band.** The coordinate stays inside the envelope but moves from one
 *     declared expression to another. Whether that needs a person is what the layer's
 *     governance says, which is why the posture is read per layer and not globally.
 *   - **Inside its band.** Nothing to weigh.
 *
 * ## Why the posture is per layer
 *
 * Because the layers are not equally negotiable and the spec already says so. A mood
 * coordinate crossing a band during a hard afternoon is the system working. A virtue
 * with hard enforcement crossing one is the thing the whole product exists to catch.
 * One global posture would either wave the second through or make the first
 * unbearable, and both make people turn enforcement off.
 *
 * ## What this deliberately does not do
 *
 * It does not estimate the effect. Whoever produced the projection owns it, and a gate
 * that guessed its own inputs would be marking its own homework. Empty effects mean
 * the axis has nothing to weigh, which is not the same as the call being safe on this
 * axis, and the header of `call.ts` says so where somebody would otherwise assume it.
 */

import { bandOf } from "../math/bands.js";
import type { Envelope } from "../envelopes.js";
import type { FrozenCall } from "./call.js";
import { ask, deny, type GuardOutcome } from "./verdict.js";

/** What a layer's governance does about a coordinate that would cross a band. */
export type CrossingPosture =
	/** Never. The coordinate is not the persona's to move this far. */
	| "locked"
	/** A person decides. */
	| "review"
	/** The persona may, and the record says it did. */
	| "autonomous";

export interface IdentityPolicy {
	/** The declared range and bands, per coordinate. */
	readonly envelopes: Readonly<Record<string, Envelope>>;
	/** Where each coordinate currently sits, so a crossing can be recognised. */
	readonly current: Readonly<Record<string, number>>;
	/**
	 * The posture for each layer, by the prefix its coordinates share.
	 *
	 * Keyed by prefix rather than by an explicit layer field because that is how the
	 * spec already addresses a coordinate: `character.virtues.honesty` names its layer
	 * in its own name. A second mapping from coordinate to layer would be one concept
	 * with two definitions, and they would drift.
	 */
	readonly postures: Readonly<Record<string, CrossingPosture>>;
	/** Used when no prefix matches. Conservative on purpose. */
	readonly fallback?: CrossingPosture;
}

/** The posture that governs a coordinate: the longest declared prefix wins. */
export function postureFor(policy: IdentityPolicy, field: string): CrossingPosture {
	let best: { length: number; posture: CrossingPosture } | undefined;
	for (const [prefix, posture] of Object.entries(policy.postures)) {
		if (field === prefix || field.startsWith(`${prefix}.`)) {
			if (!best || prefix.length > best.length) best = { length: prefix.length, posture };
		}
	}
	// An unmatched coordinate gets `review` rather than `autonomous`. A coordinate
	// nobody wrote a posture for is one nobody thought about, and the safe reading of
	// an unconsidered case is to put it in front of a person.
	return best?.posture ?? policy.fallback ?? "review";
}

/** What the axis found about one coordinate. */
export type Finding =
	| { readonly kind: "inside" }
	| { readonly kind: "crossing"; readonly from: string; readonly to: string }
	| { readonly kind: "outside"; readonly limit: "min" | "max"; readonly bound: number };

/** Weighs one projected effect against what the persona declared. */
export function examine(
	policy: IdentityPolicy,
	field: string,
	to: number,
): Finding | undefined {
	const envelope = policy.envelopes[field];
	// A coordinate with no declared envelope is not one this axis can speak about. It
	// is not silently fine; it is simply not this gate's question, and pretending
	// otherwise would produce confident answers about undeclared things.
	if (!envelope) return undefined;

	if (to < envelope.min) return { kind: "outside", limit: "min", bound: envelope.min };
	if (to > envelope.max) return { kind: "outside", limit: "max", bound: envelope.max };

	const from = policy.current[field] ?? envelope.mean;
	const before = bandOf(from, envelope);
	const after = bandOf(to, envelope);
	if (before !== after) return { kind: "crossing", from: before, to: after };
	return { kind: "inside" };
}

/**
 * The identity axis as a guard.
 *
 * Returns a reduction or nothing, like every other guard, so it composes with the
 * capability axis without either one knowing about the other. That is the point of
 * having one lattice: the two questions are asked independently and the answer is the
 * lower of them, with no precedence rule anybody has to remember.
 */
export function identityGuard(policy: IdentityPolicy) {
	return (call: FrozenCall): GuardOutcome => {
		for (const effect of call.effects) {
			const finding = examine(policy, effect.field, effect.to);
			if (!finding || finding.kind === "inside") continue;

			if (finding.kind === "outside") {
				// Leaving the declared range is not drift. It is a different persona, and
				// no posture short of the persona owning the coordinate outright lets it
				// through.
				return deny(
					`envelope:${effect.field}`,
					`this would put ${effect.field} at ${effect.to}, outside the declared ` +
						`${finding.limit} of ${finding.bound}`,
				);
			}

			const posture = postureFor(policy, effect.field);
			if (posture === "locked") {
				return deny(
					`band:${effect.field}`,
					`${effect.field} would move from ${finding.from} to ${finding.to}, and its ` +
						"layer is governance controlled",
				);
			}
			if (posture === "review") {
				return ask(
					`band:${effect.field}`,
					`${effect.field} would move from ${finding.from} to ${finding.to}, which its ` +
						"layer says a person decides",
				);
			}
		}
		return undefined;
	};
}
