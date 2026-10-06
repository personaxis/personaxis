/**
 * Resolving a setting across layers, with the winner attributable.
 *
 * `config-layers.ts` in the engine has held the ranks and the two resolution rules
 * since FR.5 and nothing called them. Meanwhile `loadMergedConfig` merges by spreading
 * project over global, which is the ordinary rule implemented by accident: it gets the
 * right answer for ordinary keys and the WRONG one for policy keys, and it can never
 * say where a value came from.
 *
 * ## The policy tier, and why telemetry is in it
 *
 * The ordinary rule is "highest layer wins", and for a model name or a statusline
 * template that is exactly right: the nearer config is the more specific intent.
 *
 * The policy rule is "strictest wins, whatever the rank", so a lower layer may tighten
 * what a higher one set and never loosen it. Telemetry belongs there, and the case is
 * concrete: somebody turns it off in their home config, then clones a repository whose
 * `.personaxis/config.json` turns it on. Under the ordinary rule the repository wins,
 * and a decision the person made about their own machine is undone by a file they
 * downloaded. Under the policy rule the off stays off, and a project can still turn it
 * off for itself.
 *
 * That is the generalisation of the improvement-mode min-wins rule the spec already
 * carries, applied to the one other setting in this config that is a decision about
 * the person rather than about the work.
 */

import { CONFIG_LAYERS, resolveLayered, resolvePolicyTier, type ConfigLayer, type LayeredValue } from "@personaxis/core";

import { loadConfig } from "./config.js";

/**
 * Strictness order for an on/off policy setting, most permissive first.
 *
 * `resolvePolicyTier` reads the index, so the direction of this array IS the rule. On
 * is permissive, off is strict, and a value outside the list never wins a policy
 * decision at all.
 */
const OFF_IS_STRICTER: readonly boolean[] = [true, false];

/** The layers this CLI actually reads from disk today. */
function layersOf<T>(pick: (config: ReturnType<typeof loadConfig>) => T | undefined) {
	return {
		global: pick(loadConfig("global")),
		project: pick(loadConfig("project")),
	} satisfies Partial<Record<ConfigLayer, T | undefined>>;
}

/**
 * Whether telemetry is on, and which layer decided.
 *
 * Off unless something turned it on, which is the documented default and the only
 * defensible one for a setting that writes a log of what somebody did.
 */
export function telemetryEnabled(): LayeredValue<boolean> {
	const resolved = resolvePolicyTier(
		layersOf((config) => config.telemetry?.enabled),
		OFF_IS_STRICTER,
	);
	// No layer said anything. Reported as the managed default rather than as an absence,
	// so a caller asking "who decided this" always gets an answer.
	return resolved ?? { value: false, source: "managed" };
}

/**
 * An ordinary setting, and where it came from.
 *
 * The attribution is the point rather than a nicety. A person asking "why is this
 * value in effect" is usually asking because it is not the one they set, and the
 * answer is always the name of a layer.
 */
export function settingFrom<T>(
	pick: (config: ReturnType<typeof loadConfig>) => T | undefined,
): LayeredValue<T> | undefined {
	return resolveLayered(layersOf(pick));
}

/** The layer ranks, for anything that needs to explain the ordering to a person. */
export { CONFIG_LAYERS };
