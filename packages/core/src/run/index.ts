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
