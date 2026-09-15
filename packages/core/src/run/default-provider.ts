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
const A_RULE_STOPPED_IT = new Set([
	"execution_error",
	"low_confidence",
	"no_progress",
	// E84: the persona asked something only a person can answer and nobody could. The rule is David's
	// (P10 of E77): stop at the question and leave it written, rather than guess.
	"question",
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
 * E94: the model gave no text and no action, twice in a row, and nothing had been done.
 *
 * Not a failure of the runtime and not an answer. The closed set already had the word, `empty`, and
 * until this existed nothing produced it on this path: the loop took the silence as a completion and
 * the turn closed answered, with nothing in it.
 */
const NOTHING_CAME_BACK = new Set(["empty"]);

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

/**
 * E25: how a compaction is described to whoever writes it down.
 *
 * The cut point and the step, because those are the two facts a reader needs to judge
 * it: WHERE it happened says whether this was the cheap planned one or the safety valve,
 * and WHEN says how far into the turn the window filled. `window-full at step 9` and
 * `turn-start at step 1` are different events and a record that called both "compaction"
 * would have lost the distinction `E6` was written to make.
 */
function whyCompacted(record: AgentResult["compactions"][number]): string {
	return `${record.cut} at step ${record.step}`;
}

/** Turns the old result into what the seam expects, without inventing anything. */
export function productOf(result: AgentResult): TurnProduct {
	const answer = result.summary ?? "";
	const stoppedBy = result.budget?.stoppedBy ?? null;
	const cost = costOf(result);
	// E25: on `common` rather than on each branch, so none of the seven exits can be
	// the one that forgets. A turn that compacted and then failed compacted all the
	// same, and the record is the place that has to know it.
	const common = {
		steps: result.steps,
		...(cost === undefined ? {} : { cost }),
		compactions: result.compactions.map((record) => ({
			why: whyCompacted(record),
			plan: record.plan,
			// E80: so the record can put a compaction before the calls of the step it came before.
			step: record.step,
		})),
		// E80: every call the gate judged, as the loop reported it. On `common` for the reason the
		// compactions are: a turn that failed after reading a reference still read it.
		calls: result.calls,
		// E83: the route the persona chose before acting, only when the decision step ran and was read.
		...(result.decision === undefined ? {} : { decision: result.decision }),
		// E84: every question put to a person, the last without an answer when the turn stopped at it.
		...((result.questions ?? []).length > 0 ? { questions: result.questions } : {}),
		// E81: the persona's list, only when it kept one. The loop's own notes (files, errors) stay in the
		// loop: they are how it survives compaction, not something the persona said.
		...((result.tasks ?? []).length > 0
			? {
					tasks: result.tasks.map((task) => ({
						text: task.text,
						status: task.status,
						...(task.verified === undefined ? {} : { verified: task.verified }),
						...(task.evidence === undefined ? {} : { evidence: task.evidence }),
					})),
				}
			: {}),
	};

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

	if (stoppedBy !== null && NOTHING_CAME_BACK.has(stoppedBy)) {
		// The failure carries the runtime's words, so a surface can say what happened without
		// putting them in the persona's mouth.
		return {
			answer: "",
			stopReason: "empty",
			failure: { code: stoppedBy, message: "the model returned no text and no action, twice in a row, so nothing was done" },
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
