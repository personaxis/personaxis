/**
 * The loop we already have, wearing the seam's shape.
 *
 * Nothing about how it runs changes. `PersonaAgent` still does what it did, still
 * emits what it emitted, and this file does exactly two things: it hands a task in and
 * it translates what comes back into the vocabulary the seam speaks.
 *
 * That is the whole point of doing it now rather than later. A seam whose only
 * implementation is the thing it was extracted from proves nothing; a seam that the
 * existing loop already goes through is one a second implementation can be measured
 * against, and the contract suite already runs an adversarial provider through the same
 * assertions.
 *
 * ## Where the translation has to make a judgement, and what it chose
 *
 * The old result says `finished` and carries what stopped it, from a dozen strings the
 * loop grew one at a time. The new one says why the turn ended, from a closed set. The
 * stops sort into three families, and every one of them is named below rather than
 * caught by a fallthrough, because a stop nobody classified is a stop that gets
 * classified by whatever the fallthrough happens to be.
 *
 *   - **it closed with what it had**: the four budget caps, the hard ceiling, and the
 *     stop conditions an operator declared. Answered when there is text a person can
 *     read, empty when there is not. A loop that ran out of steps but produced
 *     something usable **answered**, and calling that a failure would push a real reply
 *     behind an error somebody has to dismiss. The reference reaches the same place by
 *     a different route: on exhaustion it spends one more tool-free call to summarise,
 *     precisely so the turn ends with something rather than with a stop.
 *   - **a guard refused it**: a denied tool, the repetition breaker, a plan that could
 *     not survive its own gates. The turn could not continue past something it needed.
 *   - **it failed**: the loop caught an error, or verification rejected the work.
 *
 * ## The bug this had, and why nothing could see it until the REPL went through here
 *
 * The last family did not exist. `TurnProduct` had no way to say `failed`, and every
 * stop that was not a budget cap or a denied tool fell through to "answered if there is
 * text". So a run that ended in `catch` returned `agent error: the model hung up` as
 * its summary and this reported the turn **answered**, with that sentence as the
 * answer. A rejected verification reported the turn answered with the words
 * `verification failed`.
 *
 * Nothing read the stop reason in production, so nothing showed it. The moment the REPL
 * runs through the seam, two things read it: the person sees it, and the record stores
 * the answer as a `message` attributed to the persona. The persona did not say "agent
 * error". That is the forgery the author invariant exists to prevent, committed by the
 * translator, and it would have been durable and hash-chained.
 *
 * So a failure comes back as a failure now, with its text in `failure` where the
 * runtime's own words belong, and `answer` empty because the persona produced none.
 *
 * What this deliberately does **not** do is invent a reason. A stop this does not
 * recognise becomes `failed` carrying the original word, not a guess at which of the
 * seven it resembles.
 */

import { PersonaAgent, type AgentResult } from "../agent.js";
import type { LoopProvider, TurnContext, TurnProduct } from "./service.js";

/**
 * Stops that mean the turn ran out of room and closed with whatever it had.
 *
 * The runner reads a budget stop off its own ledger rather than from here, so these
 * report what they have: `answered` when there is text and `empty` when there is not,
 * which is the same distinction the runner would draw.
 */
const CLOSED_WITH_WHAT_IT_HAD = new Set([
	"max_steps",
	"max_tokens",
	"max_cost_usd",
	"max_wall_seconds",
	"budget",
	// The absolute ceiling, which is a cap an operator never had to declare.
	"hard_ceiling",
	// Stop conditions a spec asked for. The operator said "stop when this happens", so it
	// happening is the loop obeying rather than the loop breaking.
	"execution_error",
	"low_confidence",
	"no_progress",
]);

/** Stops that mean a guard would not let the turn continue. */
const REFUSED_BY_A_GUARD = new Set([
	"tool_denied",
	// The repetition breaker decided the loop was going nowhere and stopped it.
	"loop_breaker",
	// A plan that could not survive its own gates, so the work never started.
	"plan",
]);

/** Stops that mean the turn produced no answer, and something is wrong. */
const THE_TURN_FAILED = new Set([
	"error",
	// The work was done and rejected. "verification failed" is the runtime's verdict on
	// the persona, never the persona's reply, and it used to be delivered as one.
	"verification_failed",
]);

/**
 * What the run cost, when the loop was talking to something that charges.
 *
 * Absent rather than zero when there is no budget to read. A turn nobody priced and a
 * turn that cost nothing are different facts, and the second one is a measurement.
 */
function costOf(result: AgentResult): { tokens: number; usd: number } | undefined {
	const budget = result.budget;
	if (!budget) return undefined;
	if (budget.tokens === undefined && budget.costUsd === undefined) return undefined;

	return { tokens: budget.tokens ?? 0, usd: budget.costUsd ?? 0 };
}

/** Turns the old result into what the seam expects, without inventing anything. */
export function productOf(result: AgentResult): TurnProduct {
	const answer = result.summary ?? "";
	const stoppedBy = result.budget?.stoppedBy ?? null;
	const cost = costOf(result);
	const common = { steps: result.steps, ...(cost === undefined ? {} : { cost }) };

	if (result.finished) return { answer, stopReason: "answered", ...common };

	if (stoppedBy !== null && THE_TURN_FAILED.has(stoppedBy)) {
		// The summary is dropped rather than carried through. What the old loop puts there
		// on these paths is its own report of the failure, and a report is not a reply:
		// passing it on as one is what got `agent error: ...` attributed to the persona.
		return {
			answer: "",
			stopReason: "failed",
			failure: { code: stoppedBy, message: answer || stoppedBy },
			...common,
		};
	}

	if (stoppedBy !== null && REFUSED_BY_A_GUARD.has(stoppedBy)) {
		return { answer, stopReason: "refused", ...common };
	}

	if (stoppedBy === null || CLOSED_WITH_WHAT_IT_HAD.has(stoppedBy)) {
		return answer.length > 0
			? { answer, stopReason: "answered", ...common }
			: { answer, stopReason: "empty", ...common };
	}

	// A stop from a build this one does not know. Naming it as one of the seven would be
	// guessing; carrying the word through means whoever added it can see where it landed.
	return {
		answer: "",
		stopReason: "failed",
		failure: { code: "unrecognised_stop", message: "the loop stopped with " + stoppedBy },
		...common,
	};
}

/**
 * The default provider.
 *
 * Takes the agent rather than building one, because who owns the agent's lifetime is
 * the caller's business and a provider that constructed its own would quietly decide
 * it.
 */
export function defaultLoop(agent: PersonaAgent): LoopProvider {
	return {
		name: "personaxis",
		run: async (context: TurnContext): Promise<TurnProduct> => {
			const result = await agent.run(context.request.prompt);
			return productOf(result);
		},
	};
}
