/**
 * The daemon's decision, as guards over the shared cascade.
 *
 * The hook used to be a chain of `if`s in one function: out of scope, then policy,
 * then the gate. Each branch was right, and none of them was reusable, so the same
 * questions had to be re-answered wherever else a call was judged. Moving them onto
 * the cascade in core costs nothing and buys three things.
 *
 * **The identity axis comes along.** Once the daemon asks the same object as everybody
 * else, a call that would push a coordinate outside its declared envelope is refused
 * on this path too, without this file knowing what an envelope is.
 *
 * **Nothing can be added that grants.** A future guard here inherits the type that has
 * no allow case, so no amount of local cleverness can turn one of these denials into
 * a permission.
 *
 * **The reasons stay separate.** The old chain returned at the first refusal, so a
 * call refused for two reasons reported one. Widening a scope and finding the call
 * still refused, with no hint why, is how somebody concludes enforcement is broken.
 *
 * ## What did not change, on purpose
 *
 * Every rule string and every reason is preserved exactly. The regression that proves
 * it runs against the cases that existed before this file did: if a message here
 * reads differently, somebody's runbook is now wrong, and a runbook nobody can trust
 * is worse than a rule nobody moved.
 */

import { actionClassesFor, gate } from "@personaxis/core";
import type { PolicyDecision } from "@personaxis/core";

import type { EnforceRequest } from "./enforcement-endpoint.js";
import type { PolicyCache } from "./policy-cache.js";

/**
 * Refuses a directory the operator never exposed.
 *
 * First because it is the cheapest and because it is the one refusal that is about
 * consent rather than about policy. A directory nobody consented to is not a place
 * this daemon speaks for, and allowing there would mean enforcing nothing somewhere
 * the workspace cannot even see.
 */
export function scopeGuard(
	personaVersionFor: (cwd: string) => string | null,
	cwd: string,
): gate.Guard {
	return {
		name: "scope",
		check: () =>
			personaVersionFor(cwd)
				? undefined
				: gate.deny(
						"out_of_scope",
						`${cwd} is not one of the directories this machine exposed. Add it with \`personaxis connect --dir\`.`,
					),
	};
}

/**
 * Asks the cached policy, which is the capability axis on this path.
 *
 * A `gate` verdict from the policy becomes an `ask`, which is what puts it on the same
 * scale as everything else: a person looking at a call another guard already refused
 * cannot rescue it, and that falls out of the ordering rather than out of a rule
 * somebody has to remember.
 *
 * ## Why it hands back what it saw
 *
 * A guard cannot say allow, and should not: allow is the absence of an objection, not
 * an assertion. But the policy's own reasoning is worth keeping, for two different
 * reasons that both bite.
 *
 * The reply already carried a rule on the allow path, `approval:never` or
 * `allow:<pattern>`, and something downstream may show it. Flattening that to a bare
 * "allow" during a refactor would quietly take information off somebody's screen,
 * which is worse than moving it deliberately.
 *
 * And an ask needs the gate rule the policy chose. Asking the cache a second time to
 * recover it would be both wasteful and wrong: the cache can refresh between the two
 * calls, so the gate that opened would not be the one that asked.
 *
 * So the decision is handed out through `saw`, which reads as what it is, a note about
 * what happened, rather than as a verdict.
 */
export function cachedPolicyGuard(
	cache: PolicyCache,
	personaVersionId: string,
	saw?: (decision: PolicyDecision) => void,
): gate.Guard {
	return {
		name: "capability",
		check: (call) => {
			const decision = cache.decide(personaVersionId, {
				tool: call.tool,
				args_text: call.argsText,
				action_classes: [...call.actionClasses] as never,
			});
			saw?.(decision);
			switch (decision.verdict) {
				case "allow":
					return undefined;
				case "deny":
					return gate.deny(decision.rule, decision.reason);
				case "gate":
					return gate.ask(decision.rule, `approval required for ${decision.gate.action_class}`);
			}
		},
	};
}

/** Turns a hook request into the frozen call the cascade judges. */
export function callFor(request: EnforceRequest, turn: string): gate.FrozenCall {
	return gate.freezeCall({
		tool: request.tool_name,
		argsText: request.args_text,
		actionClasses: actionClassesFor(request.tool_name, request.args_text) as never,
		turn,
		// The hook's own id, when the host gave one, so the proposal, the verdict and
		// the result share an identity across three processes rather than two.
		...(request.tool_use_id ? { callId: request.tool_use_id } : {}),
	});
}
