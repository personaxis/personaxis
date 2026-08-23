/**
 * The guards that were not guards, and the two paths that used to go round the gate.
 *
 * Each one here is a thing the study found and the design did not have. They live
 * together because they share a shape: something that was treated as configuration, or
 * as prompt material, or as an internal detail, turns out to decide what a persona can
 * do, and anything that decides that belongs behind the gate.
 */

import { checkAgentBudget, type AgentBudgetConfig, type AgentBudgetSpent } from "../governance.js";
import type { FrozenCall } from "./call.js";
import { deny, type GuardOutcome } from "./verdict.js";
import type { Guard } from "./waterfall.js";

/**
 * The budget, as a guard rather than as a check somebody remembers to run.
 *
 * It was already a function returning a verdict; what it lacked was a place in the
 * cascade, so every call site had to remember to consult it and to consult it *before*
 * the tool ran rather than after. A budget checked after the call is a report, not a
 * budget.
 *
 * Two things this deliberately does not do.
 *
 * It does not stop what is already running. Refusing the next call is the whole
 * mechanism; killing a call in flight is a different decision with a different owner,
 * and conflating them is how a budget ends up leaving half-written files in somebody's
 * folder.
 *
 * And the spend it reads is passed in rather than fetched. A guard is synchronous, so
 * a guard that went to look up spend would either block the decision or read something
 * stale and not know which. Whoever opens the turn knows the number; it travels with
 * the turn.
 */
export function budgetGuard(
	spend: () => AgentBudgetSpent,
	budget?: AgentBudgetConfig,
): Guard {
	return {
		name: "budget",
		check: (): GuardOutcome => {
			const check = checkAgentBudget(spend(), budget);
			if (!check.shouldStop) return undefined;
			// Every cap that is over, not only the one that stopped it. Whoever raises
			// the first limit needs to know the second is also spent, or they raise a
			// ceiling and are surprised the run still will not move.
			const over = check.verdicts.filter((verdict) => verdict.exceeded);
			const detail = over.length > 0 ? over.map((verdict) => verdict.reason).join("; ") : "";
			return deny(
				`budget:${check.stopReason ?? "spent"}`,
				detail || "the budget for this run is spent",
			);
		},
	};
}

/**
 * A budget that counts turns, which is the axis we did not have.
 *
 * Ours cuts by money, per month, per tenant. Theirs counts turns inside one run. Both
 * are needed and neither substitutes: an agent can burn a monthly budget in one
 * afternoon's loop, and it can go round a hundred cheap times without approaching the
 * money limit. The second case is the one that looks like an agent working.
 *
 * The ceiling is the tree's, not the node's. One of the references gives each
 * subagent its own and says so plainly, which means the spend of a delegation tree can
 * exceed the parent's ceiling by design. A ceiling a delegation can step over is not a
 * ceiling.
 */
export function turnBudgetGuard(used: () => number, limit: number): Guard {
	return {
		name: "turn-budget",
		check: (): GuardOutcome => {
			const spent = used();
			if (spent < limit) return undefined;
			return deny(
				"budget:turns",
				`this run has used ${spent} of ${limit} turns, counted across the whole ` +
					"delegation tree",
			);
		},
	};
}

/**
 * Loading a skill is a tool call, because a skill body executes.
 *
 * This is the correction the study forced and it is easy to miss, because a skill
 * looks like prose. It is not: the body carries inline shell that runs **when the
 * skill is loaded**, before the model has seen a single word of it. Treating that as
 * prompt material means arbitrary execution that never crossed the gate.
 *
 * So a load is materialised as a call like any other, with the action classes a load
 * actually implies, and it goes through the same cascade. The scope question comes for
 * free: a skill living outside what the operator consented to is refused by the
 * capability axis without this file knowing anything about directories.
 */
export function skillLoadCall(skill: string, path: string, turn: string) {
	return {
		tool: "skill.load",
		argsText: `${skill} ${path}`,
		// A load reads files and may run shell. Declaring both is what lets a read-only
		// posture refuse it, which is the behaviour somebody would expect and would not
		// have got while a load was prose.
		actionClasses: ["file_read", "process_spawn"] as const,
		turn,
	};
}

/**
 * Re-checks a call that was reached indirectly.
 *
 * A bridge tool that unwraps another tool, a catalogue that resolves a name, a
 * dispatcher that forwards: each of them skips the check its own caller passed,
 * because the thing that finally runs is not the thing that was judged. One of the
 * references has this check in two places and says why in a comment: the unwrap
 * happens in two places, so the check has to.
 *
 * Ours is one function that any indirect path calls, and it takes the resolved call
 * rather than the wrapper, so what gets judged is what will run.
 *
 * The verdict is not combined with the outer one. A caller that had permission to
 * invoke the bridge has not thereby got permission for whatever the bridge resolved,
 * and combining the two would let the wrapper's allow soften the inner refusal.
 */
export function resolvedCall(
	outer: FrozenCall,
	resolved: { tool: string; argsText: string; actionClasses?: readonly string[] },
) {
	return {
		tool: resolved.tool,
		argsText: resolved.argsText,
		actionClasses: (resolved.actionClasses ?? []) as never,
		turn: outer.turn,
	};
}
