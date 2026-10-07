/**
 * E128: the three starting profiles Genesis offers, Regulated, Standard and Research.
 *
 * Every persona is alive, and what its owner controls are three things per layer, all of which exist in the
 * spec and the runtime: how far it can move (the range of each coordinate, which the runtime proves it never
 * leaves, T1), who approves what lasts (`governance.per_layer_edit_policy`), and how fast it comes back
 * (`half_life`, T6). A profile is the starting stance on those three. Until 2026-10-07 it was a set of fixed
 * numbers the builder wrote; now it is guidance the authoring model reads (`stagePrompt`), and the model sets
 * each number from the sources with the profile as the stance, so no persona gets a value nobody decided.
 */

export type GenesisProfile = "regulated" | "standard" | "research";

export const GENESIS_PROFILES: readonly GenesisProfile[] = ["regulated", "standard", "research"];

export function isGenesisProfile(value: unknown): value is GenesisProfile {
	return typeof value === "string" && (GENESIS_PROFILES as readonly string[]).includes(value);
}

/** What the profile asks of the authoring model, in words it can apply to every number and policy. */
export function profileGuidance(profile: GenesisProfile): string {
	switch (profile) {
		case "regulated":
			return [
				"regulated: the persona works where a change must be explainable and slow. Keep ranges narrow (about half",
				"what the work would otherwise allow) and half-lives short, so a displaced value returns quickly; lasting",
				"changes to any layer need a person (human_approval_required).",
			].join(" ");
		case "research":
			return [
				"research: the persona is studied and allowed to explore. Ranges may be wider (about half again what the",
				"work would otherwise allow) and half-lives longer; lasting changes to its working layers (personality,",
				"affect, cognition, memory, metacognition, persona) may apply by themselves, while identity, character,",
				"values and self_regulation still need a person.",
			].join(" ");
		default:
			return [
				"standard: ranges as wide as the work needs and no wider, half-lives in turns that fit how fast this job",
				"recovers, lasting changes to working layers under review and to identity, character, values and",
				"self_regulation only with a person.",
			].join(" ");
	}
}
