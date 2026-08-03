/**
 * J.4c, the half that was missing: asking for a plan and doing something with the verdict.
 *
 * `assessPlan` answers "would these steps be allowed" and `decidePlan` turns a model's reply
 * into proceed / rejected / unreadable. Both were built, both were tested, and **nothing
 * called either of them**. A run went straight to acting.
 *
 * This is the loop around them, and it is deliberately small: ask, decide, and either anchor
 * the plan into the conversation or hand back the reason and ask again.
 *
 * ## Opt-in, and why that is not timidity
 *
 * A planning turn costs a model call before any work starts, and for a one-step task that is
 * pure overhead. More importantly, turning it on by default would change what every existing
 * run does, and "the agent now thinks first" is a behavioural change an operator should
 * choose rather than discover.
 *
 * ## Bounded attempts, and what happens at the end of them
 *
 * A model whose plan is refused can produce a better one, because the feedback names the
 * step, the tool and the rule. It can also produce the same plan again with different words.
 * So attempts are bounded, and running out **stops the run**.
 *
 * The alternative, proceeding anyway, is the worst option available: it spends the planning
 * turn, tells the operator the plan was refused, and then does the work regardless, which
 * teaches everybody that the gate is decorative.
 */

import { decidePlan, type PlanOutcome } from "./plan-phase.js";
import type { PlanStep } from "./planner.js";
import type { Policy } from "./sandbox.js";
import type { ChatMessage } from "./tool-calling.js";
import type { ToolSpec } from "./tools/registry.js";

export interface PlanPhaseConfig {
	/** Off unless asked for. */
	enabled?: boolean;
	/**
	 * How many plans to read before giving up.
	 *
	 * Two by default: one to write it, one to correct it after being told exactly what was
	 * refused. A third attempt after two refusals is usually the same plan reworded, and the
	 * cost of finding that out is another model call.
	 */
	maxAttempts?: number;
}

export type PlanPhaseResult =
	| { ok: true; anchor: string; steps: PlanStep[]; attempts: number }
	/** The run must not start. `reason` is what the operator reads. */
	| { ok: false; reason: string; attempts: number };

/** Asks for the plan as JSON and nothing else. */
export const PLAN_INSTRUCTION =
	"Before acting, plan. Reply with ONLY a JSON array of steps, each " +
	'{"tool": "<tool name>", "why": "<one line>"}. No prose, no code fence. ' +
	"List only steps you intend to take, in order.";

export interface PlanPhaseDeps {
	/** Asks the model for text. Injected so this is testable without a provider. */
	ask: (messages: ChatMessage[]) => Promise<string>;
	tools: readonly ToolSpec[];
	policy: Policy;
	/** Told what happened, for the transcript a person reads. */
	onOutcome?: (outcome: PlanOutcome, attempt: number) => void;
}

/**
 * Run the planning phase.
 *
 * `conversation` is the run's messages so far, used as context and never mutated: the caller
 * decides what to keep, because a rejected plan and its feedback are a conversation the
 * operator may or may not want in the record.
 */
export async function runPlanPhase(
	conversation: readonly ChatMessage[],
	deps: PlanPhaseDeps,
	config: PlanPhaseConfig = {},
): Promise<PlanPhaseResult> {
	const maxAttempts = Math.max(1, config.maxAttempts ?? 2);
	const exchange: ChatMessage[] = [...conversation, { role: "system", content: PLAN_INSTRUCTION }];

	let lastReason = "the model produced no plan";

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const raw = await deps.ask(exchange);
		const outcome = decidePlan(raw, deps.tools, deps.policy);
		deps.onOutcome?.(outcome, attempt);

		if (outcome.kind === "proceed") {
			return { ok: true, anchor: outcome.anchor, steps: outcome.steps, attempts: attempt };
		}

		lastReason = outcome.feedback;

		// The refused plan and the reason both go back, in that order. Sending only the
		// reason loses what it was a reason about, and the next plan repeats the step that
		// was refused because nothing in the context says which one it was.
		exchange.push({ role: "assistant", content: raw });
		exchange.push({ role: "system", content: outcome.feedback });
	}

	return {
		ok: false,
		reason: `No runnable plan after ${maxAttempts} attempt(s). ${lastReason}`,
		attempts: maxAttempts,
	};
}
