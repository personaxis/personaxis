/**
 * The policy that arrived on the wire, turned into one the hook can enforce.
 *
 * The protocol carries a REF: a persona version, a hash, and the rules as an opaque
 * value. The cache holds a `CompiledPolicy`, which is a specific shape with deny
 * lists, an egress allowlist, gate rules and a TTL. Between the two there has to be a
 * check, and it is not ceremony.
 *
 * THE HASH IS RECOMPUTED HERE. The server says what the policy hashes to; this works
 * it out from the rules themselves and refuses when they disagree. A policy that
 * arrives malformed, or altered between the workspace and this machine, would
 * otherwise be enforced as if somebody had written it, and the hook would report
 * every decision it made with complete confidence. Enforcing a policy nobody wrote is
 * worse than enforcing none, because it looks like enforcement.
 *
 * And it refuses rather than repairing. Filling in a missing deny list with an empty
 * one turns "this policy is broken" into "this persona may do anything", which is the
 * direction a guess must never go.
 */

import { hashPolicy, type CompiledPolicy } from "@personaxis/core";
import type { CompiledPolicyRef } from "@personaxis/protocol/workspace";

/** Every field the hook reads, so a partial policy is refused rather than half-applied. */
const REQUIRED_LISTS = [
	"deny",
	"allow",
	"hard_limits",
	"prohibited_behaviors",
	"egress_allowlist",
] as const;

export type PolicyRefProblem =
	| "not-an-object"
	| "missing-fields"
	| "wrong-persona"
	| "hash-mismatch";

export function policyFromRef(
	ref: CompiledPolicyRef,
): { ok: true; policy: CompiledPolicy } | { ok: false; problem: PolicyRefProblem } {
	const rules = ref.rules;
	if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
		return { ok: false, problem: "not-an-object" };
	}

	const candidate = rules as Record<string, unknown>;

	for (const field of REQUIRED_LISTS) {
		if (!Array.isArray(candidate[field])) return { ok: false, problem: "missing-fields" };
	}
	if (typeof candidate.ttl_seconds !== "number" || typeof candidate.compiled_at !== "string") {
		return { ok: false, problem: "missing-fields" };
	}

	// The rules carry their own persona id and so does the envelope. Two answers to
	// "whose policy is this" is one too many, and the wrong one would cache a policy
	// under a version it does not govern.
	if (candidate.persona_version_id !== ref.persona_version_id) {
		return { ok: false, problem: "wrong-persona" };
	}

	const policy = { ...candidate, hash: ref.hash } as CompiledPolicy;
	const { hash: _ignored, ...withoutHash } = policy;
	if (hashPolicy(withoutHash) !== ref.hash) return { ok: false, problem: "hash-mismatch" };

	return { ok: true, policy };
}

/** What to tell the workspace when a policy is refused. */
export function describePolicyProblem(problem: PolicyRefProblem): string {
	switch (problem) {
		case "not-an-object":
			return "the policy that came with this job was not a policy";
		case "missing-fields":
			return "the policy that came with this job is missing rules the hook enforces";
		case "wrong-persona":
			return "the policy that came with this job names a different persona version";
		case "hash-mismatch":
			return "the policy that came with this job does not match its own hash";
	}
}
