/**
 * Where a run happens, and what it may touch while it is there.
 *
 * Two ideas, and the second is the one that took the study to see. Confinement is a
 * mode kept apart from the backend that applies it, because both families that apply it
 * must apply the same one or the persona ends up living in two places at once. And a
 * world is a **group** of seams, files and processes together, swapped as a group or not
 * at all, because remote execution is not another way of confining.
 */

export {
	applyWith,
	effectiveMode,
	egressAllowed,
	narrower,
	type ApplyDecision,
	type BackendReport,
	type Completeness,
	type ConfinementMode,
	type ConfinementPolicy,
	type ModeEvent,
} from "./policy.js";

export {
	canHandOver,
	choose,
	coherent,
	describeRefusal,
	type World,
	type WorldChoice,
	type WorldKind,
	type WorldRefusal,
	type WorldSeams,
} from "./group.js";
