/**
 * Running turns.
 *
 * The loop is a seam with our loop as the default provider, so a customer bringing
 * their own is a configuration change. Consumers hold a `TurnRunner` and never see the
 * provider, which is the whole reason the swap is cheap.
 *
 * What to read first: `service.ts`, and specifically why a provider cannot skip closing
 * a turn. It is the correction to the one place the reference's own contract is
 * violated twenty-five times by people who knew the rule.
 */

export {
	answered,
	type StopReason,
	type TurnOutcome,
	type TurnRequest,
} from "./vocabulary.js";

export { Ledger, describeRoom, type Ceiling, type Room, type Spend } from "./budget.js";

export {
	TurnRunner,
	type LoopProvider,
	type RunnerOptions,
	type TurnContext,
	type TurnObserver,
	type TurnProduct,
} from "./service.js";

export { breakerGuard, nudgeFor, type Nudge } from "./breaker-guard.js";

export { defaultLoop, productOf } from "./default-provider.js";
export { agentOptionsFor, runnerFor, type PersonaFacts, type SessionOptions } from "./runner-for.js";
export {
	assemble,
	compiledPathFor,
	identityOf,
	isSubagentPath,
	type AssembledPersona,
} from "./assembled.js";

export {
	appraiserFor,
	evolverFor,
	type Evolver,
	type EvolvingFacts,
	type EvolvingSession,
	type Recompile,
} from "./evolving.js";

export {
	catalogue,
	loadableOnRequest,
	mayRewrite,
	type CatalogueContext,
	type CatalogueView,
	type Provenance,
	type ScanVerdict,
	type SkillEntry,
	type Tier,
	type Withheld,
} from "./skill-catalogue.js";

export {
	EFFORT_LADDER,
	forDestination,
	mayReplay,
	resolveEffort,
	type DestinationCapabilities,
	type Effort,
	type ModelRequest,
	type Transport,
} from "./model-seam.js";

export {
	deepen,
	delegate,
	delegationAuthor,
	ledgerForChild,
	scopeStatement,
	type DelegatedScope,
	type DelegationRequest,
	type DelegationResult,
	type ExplicitScope,
} from "./delegation.js";

export { recordTurns, type RecordingOptions } from "./recording.js";
