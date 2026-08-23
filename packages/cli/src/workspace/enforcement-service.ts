/**
 * The daemon's answer to "may this call run".
 *
 * It sits between three things that each know a piece: the hook, which knows
 * what is about to happen; the policy cache, which knows the persona's limits;
 * and the connection, which knows how to ask a person. This is where the three
 * meet, and it is the last place a decision is still local.
 *
 * A gate holds the hook open. That is the mechanism behind the freeze someone
 * sees in the workspace: the tool call has not run, the process is waiting on
 * a socket, and a person is looking at it. It is also why the timeout here has
 * to be real, and why running out of it is a refusal.
 */

import type { PolicyDecision } from "@personaxis/core";
import { gate } from "@personaxis/core";

import type { EnforceReply, EnforceRequest } from "./enforcement-endpoint.js";
import { callFor, cachedPolicyGuard, noPersonaGuard, scopeGuard } from "./enforcement-guards.js";
import type { PolicyCache } from "./policy-cache.js";

/** How long a person has, before the gate answers for them. */
export const DEFAULT_GATE_TIMEOUT_MS = 30 * 60 * 1000;

export interface GateRequest {
	call_id: string;
	tool: string;
	args_text: string;
	action_class: string;
	required_approvals: number;
	timeout_seconds: number;
}

export type GateOutcome = "approved" | "denied" | "expired";

export interface EnforcementDeps {
	cache: PolicyCache;
	/**
	 * The directories the operator consented to expose, as they typed them.
	 *
	 * The authority on whether a call is in scope, and deliberately not the same
	 * question as which persona acts there. Empty means empty: a daemon with no
	 * consented directory refuses everywhere rather than defaulting to somewhere.
	 */
	scope: readonly string[];
	/** Which persona this working directory is acting as. */
	personaVersionFor: (cwd: string) => string | null;
	/**
	 * Opens a gate and waits. Resolves with what a person decided, or with
	 * "expired" when nobody did in time.
	 */
	openGate?: (request: GateRequest) => Promise<GateOutcome>;
	/** Reports the decision, so the record holds allows as well as refusals. */
	report?: (decision: PolicyDecision, request: EnforceRequest) => void;
	now?: () => number;
	/**
	 * Extra guards this deployment mounts, judged alongside the built-in ones.
	 *
	 * The identity axis arrives through here, and so does anything a component adds
	 * while it is active. They cannot loosen anything: the type they return has no
	 * allow case, so mounting one can only ever make the daemon refuse more.
	 */
	guards?: readonly gate.Guard[];
}

/**
 * Builds the handler the socket serves.
 *
 * Written as a factory over injected dependencies rather than a class reaching
 * for globals, because the interesting behaviour is what happens when one of
 * them is missing or slow, and that has to be testable without a workspace.
 */
export function enforcementHandler(deps: EnforcementDeps) {
	return async function handle(request: EnforceRequest): Promise<EnforceReply> {
		const personaVersionId = deps.personaVersionFor(request.cwd);
		const call = callFor(request, request.tool_use_id ?? "hook");

		// Every guard runs, so a call refused twice reports both reasons. The old chain
		// returned at the first one, and somebody who widened a scope then found the
		// call still refused with no hint why concluded enforcement was broken.
		let policyDecision: PolicyDecision | undefined;
		const guards: gate.Guard[] = [scopeGuard(deps.scope, request.cwd)];
		if (personaVersionId) {
			guards.push(
				cachedPolicyGuard(deps.cache, personaVersionId, (seen) => {
					policyDecision = seen;
				}),
			);
		} else {
			// Consented, but nobody has said who acts here. Still a refusal, under its
			// own name: without this the guard list would be a scope check that passed
			// and nothing else, which is an allow.
			guards.push(noPersonaGuard(request.cwd));
		}
		guards.push(...(deps.guards ?? []));

		const result = gate.runGuards(guards, call);

		// The report keeps the old shape, because it is what the workspace already
		// reads. What it reports is the strongest contribution, which for an allow is
		// nothing and for anything else is the reason that decided it.
		const strongest = result.contributions[0];
		deps.report?.(policyDecision ?? reportable(result.verdict, strongest), request);

		if (result.verdict === "allow") {
			// The policy's own rule, not a flattened "allow". Something downstream shows
			// it, and a refactor that quietly replaced `approval:never` with a bare word
			// would take information off a screen without anybody deciding to.
			return { verdict: "allow", rule: policyDecision?.rule ?? "allow", reason: "" };
		}

		if (result.verdict === "deny") {
			return {
				verdict: "deny",
				rule: strongest?.rule ?? "deny",
				// Both reasons when there are two, because widening one leaves the other.
				reason: result.contributions.map((entry) => entry.reason).join("; "),
			};
		}

		// An ask, which only the policy raises today. The rule it named is carried
		// through so the gate that opens is traceable to what asked for it.
		// The decision the guard actually saw, rather than a second lookup. Asking the
		// cache again could return a different answer, and the gate that opened would
		// then not be the one that asked for it.
		const decision = policyDecision;
		if (decision?.verdict !== "gate") {
			// Only the policy raises an ask today, so reaching here without its gate rule
			// means something else did, and there is no configured gate to open. Refusing
			// is the honest answer: inventing one would open a gate nobody set up.
			const asking = result.contributions.find((entry) => entry.verdict === "ask");
			return {
				verdict: "deny",
				rule: asking?.rule ?? "gate",
				reason: asking
					? `${asking.reason}, and this machine has no gate rule to open for it`
					: "this call needs approval and there is no gate rule for it",
			};
		}

		// A gate with nobody to ask is a refusal, not a pause. Without this, a
		// disconnected machine would hold every gated call open until the host
		// gave up, which looks like a hang and teaches people to disable it.
		if (!deps.openGate) {
			return {
				verdict: "deny",
				rule: decision.rule,
				reason:
					"this call needs approval and this machine cannot reach the workspace to ask for it",
			};
		}

		const outcome = await deps.openGate({
			call_id: call.callId,
			tool: request.tool_name,
			args_text: request.args_text,
			action_class: decision.gate.action_class,
			required_approvals: decision.gate.required_approvals,
			timeout_seconds: decision.gate.timeout_seconds,
		});

		if (outcome === "approved") {
			return { verdict: "allow", rule: `${decision.rule}:approved`, reason: "" };
		}

		return {
			verdict: "deny",
			rule: `${decision.rule}:${outcome}`,
			reason:
				outcome === "denied"
					? "a person declined this call in the workspace"
					: "nobody answered the approval in time, so the call was refused",
		};
	};
}

/**
 * The old decision shape, for the report the workspace already reads.
 *
 * Rebuilt rather than threaded through, because the cascade's result is richer and
 * the wire is not. Changing the wire is a separate decision with its own migration,
 * and doing it quietly inside a refactor is how a workspace starts showing blanks.
 */
function reportable(
	verdict: gate.Verdict,
	strongest: gate.Contribution | undefined,
): PolicyDecision {
	if (verdict === "allow" || !strongest) return { verdict: "allow", rule: "allow" };
	if (strongest.verdict === "deny") {
		return { verdict: "deny", rule: strongest.rule, reason: strongest.reason };
	}
	return {
		verdict: "gate",
		rule: strongest.rule,
		gate: {
			action_class: "external_write",
			required_approvals: 1,
			route: {},
			timeout_seconds: Math.floor(DEFAULT_GATE_TIMEOUT_MS / 1000),
		},
	};
}
