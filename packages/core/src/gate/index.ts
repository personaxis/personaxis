/**
 * The gate.
 *
 * Two questions about every call, asked independently, and the answer is the lower of
 * them. **May this happen** is the question every runtime asks. **Does this leave me
 * being who I said I am** is ours, and nobody else can ask it because nobody else
 * declares an envelope before the agent starts.
 *
 * What to read first: `verdict.ts`, which is short and is where the guarantee lives.
 * The rest is arrangement around it.
 */

export {
	ask,
	decide,
	deny,
	meet,
	permitsAtLeast,
	type Contribution,
	type Decision,
	type GuardOutcome,
	type Verdict,
} from "./verdict.js";

export { freezeCall, type CallDraft, type CoordinateEffect, type FrozenCall } from "./call.js";

export {
	GuardSet,
	runGuards,
	type GateResult,
	type Guard,
} from "./waterfall.js";

export {
	examine,
	identityGuard,
	postureFor,
	type CrossingPosture,
	type Finding,
	type IdentityPolicy,
} from "./identity.js";

export { capabilityGuard, requirePolicy } from "./capability.js";
