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

import type { PolicyCall, PolicyDecision } from "@personaxis/core";
import { actionClassesFor } from "@personaxis/core";

import type { EnforceReply, EnforceRequest } from "./enforcement-endpoint.js";
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
		if (!personaVersionId) {
			// A directory the operator never consented to is not a directory this
			// daemon speaks for. Refusing is the honest answer: allowing would
			// mean enforcing nothing in a place the workspace cannot see.
			return {
				verdict: "deny",
				rule: "out_of_scope",
				reason: `${request.cwd} is not one of the directories this machine exposed. Add it with \`personaxis connect --dir\`.`,
			};
		}

		const call: PolicyCall = {
			tool: request.tool_name,
			args_text: request.args_text,
			action_classes: actionClassesFor(request.tool_name, request.args_text),
		};

		const decision = deps.cache.decide(personaVersionId, call);
		deps.report?.(decision, request);

		if (decision.verdict === "allow") {
			return { verdict: "allow", rule: decision.rule, reason: "" };
		}

		if (decision.verdict === "deny") {
			return { verdict: "deny", rule: decision.rule, reason: decision.reason };
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
			call_id: request.tool_use_id ?? `${request.tool_name}:${deps.now?.() ?? Date.now()}`,
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
