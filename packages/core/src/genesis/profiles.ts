/**
 * E128: the three starting profiles Genesis offers, Regulated, Standard and Research.
 *
 * ## What a profile is, and what it is not
 *
 * David decided the model on 2026-09-23 (plan, section 13.9): there are no modes a persona is sold in.
 * Every persona is alive, and what its owner controls are three things per layer, all of which already
 * exist in the spec and in the runtime:
 *
 *   1. how far it can move: the range of each coordinate, which the runtime proves it never leaves (T1);
 *   2. who approves what lasts: `governance.per_layer_edit_policy`, which `editGate` applies layer by layer;
 *   3. how fast it comes back: `half_life` per coordinate (T6).
 *
 * A profile is nothing but the starting values of those three. So all three profiles are born
 * `suggesting`, alive, and none of them is `locked`, which is the kill-switch and not a way to sell
 * a persona. And a profile never overrides what the owner said: an answer in the interview or a value
 * the extraction found with evidence wins over the profile's default, the same rule every default in
 * Genesis follows.
 *
 * ## The numbers
 *
 * Standard is what Genesis wrote before profiles existed, unchanged, so a persona created without
 * choosing one is the persona it always was. The other two move each control in the direction its
 * name promises and by a factor, not by an invented absolute: Regulated halves how far a coordinate
 * can move and how long a deviation lasts; Research widens the ranges by half again, doubles how long a
 * deviation lasts, and lets the persona apply lasting changes to its working layers by itself. Who it is (identity, character, values) needs a person in
 * all three, and `self_regulation` follows governance in all three, because those are the layers a
 * persona must never rewrite on its own.
 *
 * Regulated writes `human_approval_required` on the working layers where Standard writes `review_required`.
 * Today `editGate` queues both for a person alike, so the report does not promise Regulated anything more
 * there: the spec keeps the two words apart for whoever reads the queue, and the difference Regulated
 * actually buys is in the ranges and the half-lives.
 */

export type GenesisProfile = "regulated" | "standard" | "research";

export const GENESIS_PROFILES: readonly GenesisProfile[] = ["regulated", "standard", "research"];

export interface ProfileControls {
	/** Multiplies how far each default envelope reaches from its mean. */
	readonly rangeScale: number;
	/** Half-life, in turns, of every affect coordinate (the fast layer). */
	readonly affectHalfLife: number;
	/** Half-life, in turns, of every personality trait (the slow layer). */
	readonly personalityHalfLife: number;
	/** `governance.per_layer_edit_policy`, written whole. */
	readonly perLayer: Readonly<Record<string, string>>;
	/** One line for the creation report, in the owner's terms. */
	readonly says: string;
}

/**
 * The per-layer policy in the spec's canonical order, so a Standard persona is written byte for byte as it
 * was before profiles existed. Who it is (identity, character, values) needs a person in every profile, and
 * self_regulation always follows governance; `working` is what the profile decides for the other six.
 */
function perLayer(working: string): Record<string, string> {
	return {
		identity: "human_approval_required",
		character: "human_approval_required",
		personality: working,
		values_and_drives: "human_approval_required",
		affect: working,
		cognition: working,
		memory: working,
		metacognition: working,
		self_regulation: "governance_controlled",
		persona: working,
	};
}

const PROFILES: Record<GenesisProfile, ProfileControls> = {
	regulated: {
		rangeScale: 0.5,
		affectHalfLife: 2,
		personalityHalfLife: 12,
		perLayer: perLayer("human_approval_required"),
		says: "Regulated: half the room to move and a return to baseline twice as fast; a person approves every lasting change.",
	},
	standard: {
		rangeScale: 1,
		affectHalfLife: 4,
		personalityHalfLife: 24,
		perLayer: perLayer("review_required"),
		says: "Standard: moderate room to move; a person approves every lasting change.",
	},
	research: {
		rangeScale: 1.5,
		affectHalfLife: 8,
		personalityHalfLife: 48,
		perLayer: perLayer("auto_approved"),
		says:
			"Research: half again the room to move and a return twice as slow; it applies lasting changes to how it works by itself, and who it is still needs a person.",
	},
};

/** The controls a profile starts a persona with. An absent profile is Standard, which is what Genesis always wrote. */
export function profileControls(profile: GenesisProfile | undefined): ProfileControls {
	return PROFILES[profile ?? "standard"];
}

/** True for one of the three profile names. */
export function isGenesisProfile(value: unknown): value is GenesisProfile {
	return typeof value === "string" && (GENESIS_PROFILES as readonly string[]).includes(value);
}
