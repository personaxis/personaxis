/**
 * The policy the daemon decides against, and when it stops trusting it.
 *
 * A cache here is not an optimisation, it is the reason enforcement can be
 * local at all: asking a server before every tool call would put a network
 * round trip inside a 150 ms budget and make someone's agent unusable from a
 * train.
 *
 * The interesting part is expiry. A cached policy that outlived its TTL is not
 * "probably still right", it is a policy whose owner may have revoked a
 * permission ten minutes ago. So an expired entry does not fall back to itself:
 * every decision made against it is a denial naming `stale_cache`. The cost is
 * an agent that stops working while its machine is cut off from the workspace,
 * which is the correct cost, because the alternative is an agent that keeps
 * acting on limits nobody can update.
 */

import {
	compile,
	evaluate,
	isExpired,
	type CompiledPolicy,
	type ExecutablePolicy,
	type PolicyCall,
	type PolicyDecision,
} from "@personaxis/core";

interface Entry {
	executable: ExecutablePolicy;
	policy: CompiledPolicy;
}

export class PolicyCache {
	private readonly entries = new Map<string, Entry>();
	private readonly now: () => Date;

	constructor(now: () => Date = () => new Date()) {
		this.now = now;
	}

	/** Compiles once, on the way in. `evaluate` compiles nothing. */
	put(policy: CompiledPolicy): void {
		this.entries.set(policy.persona_version_id, { policy, executable: compile(policy) });
	}

	has(personaVersionId: string): boolean {
		return this.entries.has(personaVersionId);
	}

	/** What the daemon reports at registration, so the server can skip pushes. */
	summary(): Array<{ persona_version_id: string; hash: string }> {
		return [...this.entries.values()].map((entry) => ({
			persona_version_id: entry.policy.persona_version_id,
			hash: entry.policy.hash,
		}));
	}

	drop(personaVersionId: string): void {
		this.entries.delete(personaVersionId);
	}

	/**
	 * Decides for one call.
	 *
	 * Three ways to reach a denial without consulting a rule, and each one is a
	 * state where the policy cannot be trusted rather than an error: no policy
	 * for this persona, a policy past its TTL, or a call the caller could not
	 * describe. All three name themselves in the verdict, because "denied" with
	 * no reason is what makes people turn enforcement off.
	 */
	decide(personaVersionId: string, call: PolicyCall): PolicyDecision {
		const entry = this.entries.get(personaVersionId);
		if (!entry) {
			return {
				verdict: "deny",
				rule: "no_policy",
				reason: `this machine holds no policy for ${personaVersionId}, so it cannot check this call`,
			};
		}

		if (isExpired(entry.policy, this.now())) {
			// Kept rather than dropped: the workspace may come back in a second,
			// and re-fetching is the daemon's job, not this call's.
			return {
				verdict: "deny",
				rule: "stale_cache",
				reason:
					"this machine's copy of the policy is older than its lifetime and the workspace could not be reached to refresh it",
			};
		}

		return evaluate(entry.executable, call);
	}
}
