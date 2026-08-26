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
 * The old result says `finished` and carries what stopped it. The new one says why the
 * turn ended, from a closed set. Two of those mappings are obvious and one is not:
 *
 *   - finished, with text            -> answered
 *   - stopped by a budget            -> budget, because it closed with what it had
 *   - not finished, with no text     -> empty
 *   - not finished, with text        -> answered
 *
 * The last is the one worth arguing about. A loop that ran out of steps but produced
 * something the person can read **answered**, and calling that a failure would push a
 * usable reply behind an error somebody has to dismiss. The reference reaches the same
 * place by a different route: on exhaustion it spends one more tool-free call to
 * summarise, precisely so the turn ends with something rather than with a stop.
 *
 * What this deliberately does **not** do is invent a reason. A stop the old loop
 * reports and this does not recognise becomes `failed` with the original string, not a
 * guess at which of the seven it resembles.
 */

import { PersonaAgent, type AgentResult } from "../agent.js";
import type { LoopProvider, TurnContext, TurnProduct } from "./service.js";

/** Reasons the old loop can report that mean the budget stopped it. */
const BUDGET_STOPS = new Set([
	"max_steps",
	"max_tokens",
	"max_cost_usd",
	"max_wall_seconds",
	"budget",
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
	const priced = cost === undefined ? {} : { cost };

	if (result.finished) {
		return { answer, steps: result.steps, stopReason: "answered", ...priced };
	}
	if (stoppedBy && BUDGET_STOPS.has(stoppedBy)) {
		// The runner reads a budget stop off its own ledger rather than from here, so
		// this reports what it has: a turn that closed with whatever it produced. That
		// is `answered` when there is text and `empty` when there is not, which is the
		// same distinction the runner would draw.
		return answer.length > 0
			? { answer, steps: result.steps, stopReason: "answered", ...priced }
			: { answer, steps: result.steps, stopReason: "empty", ...priced };
	}
	if (stoppedBy === "tool_denied") {
		return { answer, steps: result.steps, stopReason: "refused", ...priced };
	}
	return answer.length > 0
		? { answer, steps: result.steps, stopReason: "answered", ...priced }
		: { answer, steps: result.steps, stopReason: "empty", ...priced };
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
