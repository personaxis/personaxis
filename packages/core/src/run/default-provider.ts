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
 *   - **it ran out of room**: the four caps and the hard ceiling. `budget`.
 *   - **a rule stopped it**: the stop conditions an operator declared. `stopped`.
 *   - **a guard refused it**: a denied tool, the repetition breaker, a plan that could
 *     not survive its own gates. The turn could not continue past something it needed.
 *   - **it failed**: the loop caught an error, or verification rejected the work.
 *
 * Only a loop that said it was DONE comes back `answered`. The first two families used
 * to as well, whenever they had text to show, on the reasoning that a usable reply
 * pushed behind an error is a reply somebody has to dismiss. That reasoning is right
 * and the word was wrong: the turn still ends with what it had, and `answered(reason)`
 * still says so, but "the loop finished" and "the loop stopped" stopped being the same
 * sentence. The reference reaches the delivery half by a different route, spending one
 * more tool-free call to summarise on exhaustion.
 *
 * ## The other bug, and why nothing could see it until the REPL went through here
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
 *
 * ## The transcript goes back where it came from
 *
 * This loop keeps a transcript, and the REPL needs it to answer the next turn in the
 * same conversation. It had been taking it off `agent.lastMessages`, which is reaching
 * past the seam for the one thing the seam cannot carry: a scripted provider has no
 * messages, so a transcript in `TurnOutcome` would make the result describe the shape
 * of this particular loop.
 *
 * So the session lends a `Conversation` and this gives it back. A provider that keeps
 * no transcript never touches it, and the continuity it cannot offer is honestly
 * absent instead of quietly empty.
 */

import { PersonaAgent, type AgentResult } from "../agent.js";
import type { Conversation } from "./conversation.js";
import type { LoopProvider, TurnContext, TurnProduct } from "./service.js";

/** Stops that mean there was no room left, and the turn closed with what it had. */
const RAN_OUT_OF_ROOM = new Set([
	"max_steps",
	"max_tokens",
	"max_cost_usd",
	"max_wall_seconds",
	"budget",
	// The absolute ceiling, which is a cap an operator never had to declare.
	"hard_ceiling",
	// The wall-clock watchdog, which stops a run hung inside a tool call where the
	// step-boundary check never runs. A ceiling like any other, and it used to fall
	// through to "answered if there is text" along with everything else.
	"watchdog",
]);

/**
 * Stops that mean a declared rule ended the turn early.
 *
 * The operator wrote `stop_conditions: [no_progress]` and it happened, so the loop was
 * obeying rather than breaking. Kept apart from a ceiling because a rule and a ceiling
 * are different things, and reporting one as the other tells somebody their budget ran
 * out when their rule fired.
 */
const A_RULE_STOPPED_IT = new Set(["execution_error", "low_confidence", "no_progress"]);

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

	// Whatever it had comes back with it, empty included. The answer and the reason are
	// separate facts: a caller that wants to know whether there is something to show
	// reads the answer, and one that wants to know whether the loop finished reads this.
	if (stoppedBy !== null && RAN_OUT_OF_ROOM.has(stoppedBy)) {
		return { answer, stopReason: "budget", ...common };
	}
	if (stoppedBy !== null && A_RULE_STOPPED_IT.has(stoppedBy)) {
		return { answer, stopReason: "stopped", ...common };
	}

	if (stoppedBy === null) {
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
 *
 * `conversation` is where the transcript is handed back. It is written even when the
 * turn produced nothing usable: the messages that led nowhere are still what was said,
 * and dropping them would make the next turn re-ask a question this one already put to
 * the model.
 */
export function defaultLoop(agent: PersonaAgent, conversation?: Conversation): LoopProvider {
	return {
		name: "personaxis",
		run: async (context: TurnContext): Promise<TurnProduct> => {
			try {
				const result = await agent.run(context.request.prompt);
				return productOf(result);
			} finally {
				if (conversation && agent.lastMessages) conversation.write(agent.lastMessages);
			}
		},
	};
}
