/**
 * The first axis, as a guard: may this call happen at all?
 *
 * The existing policy layer already answers this and answers it well, with the
 * regexes compiled once and a 150 ms budget it stays inside. Rewriting it would be
 * churn. What it needed was to stop being the whole gate and become one voice in it,
 * so the identity axis can sit beside it without either knowing about the other.
 *
 * The adaptation is small and one part of it matters. `evaluate` returns an `allow`
 * and this returns nothing in that case, because a guard has no way to say allow and
 * should not: allow is the absence of an objection, not an assertion. Keeping the
 * asymmetry is what stops somebody later adding an allow case "for symmetry" and
 * quietly making a permission expressible.
 */

import { evaluate, type ExecutablePolicy } from "../enforcement/policy-compile.js";
import type { FrozenCall } from "./call.js";
import { ask, deny, type GuardOutcome } from "./verdict.js";
import type { Guard } from "./waterfall.js";

/** Wraps the compiled policy so it can stand in the waterfall. */
export function capabilityGuard(policy: ExecutablePolicy): Guard {
	return {
		name: "capability",
		check: (call: FrozenCall): GuardOutcome => {
			const decision = evaluate(policy, {
				tool: call.tool,
				args_text: call.argsText,
				action_classes: [...call.actionClasses],
			});
			switch (decision.verdict) {
				case "allow":
					return undefined;
				case "deny":
					return deny(decision.rule, decision.reason);
				case "gate":
					return ask(
						decision.rule,
						`this needs ${decision.gate.required_approvals} approval(s) for ` +
							`${decision.gate.action_class}`,
					);
			}
		},
	};
}

/**
 * A guard that refuses when there is no policy to consult.
 *
 * Explicit and registered rather than a branch inside the waterfall, because the
 * waterfall with no guards allows, and "there is no policy" has to be a refusal
 * somebody can see in the list of guards rather than a special case buried in a loop.
 * Every path that is not a clear allow denies and names itself, and this is the path
 * where the thing that would have allowed is simply absent.
 */
export function requirePolicy(policy: ExecutablePolicy | undefined): Guard {
	return {
		name: "policy-present",
		check: (): GuardOutcome =>
			policy
				? undefined
				: deny("no_policy", "no compiled policy is loaded, so nothing can authorise this"),
	};
}
