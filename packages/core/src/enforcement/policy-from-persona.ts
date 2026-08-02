/**
 * From a persona document to the policy a machine enforces.
 *
 * This is the step that makes the spec load-bearing rather than descriptive. A
 * persona declares `permissions.deny`, three hard limits and a sandbox posture;
 * until something turns those into a decision at a tool call, they are prose
 * about intentions. This function is that turn, and it is deliberately dull:
 * every field maps to exactly one field, nothing is inferred, and what the spec
 * does not say is not invented.
 *
 * It lives in core and not in the CLI because both ends need the identical
 * result. The daemon compiles the persona it has on disk; the workspace
 * compiles the version it stores and pushes it to machines. If those two
 * disagreed, a persona would behave differently depending on who compiled it,
 * which is the failure this whole layer exists to prevent. The hash is what
 * makes the agreement checkable rather than assumed.
 */

import { hashPolicy, type ApprovalPosture, type CompiledPolicy, type GateRule } from "./policy-compile.js";
import type { SandboxPosture } from "../security/consent.js";

/** The parts of a persona this reads. Everything else is none of its business. */
export interface PersonaPolicySource {
	permissions?: {
		sandbox?: string;
		approval?: string;
		allow?: string[];
		deny?: string[];
	};
	self_regulation?: { hard_limits?: string[] };
	character?: { prohibited_behaviors?: string[] };
}

export interface PolicyFromPersonaOptions {
	/**
	 * Hosts this persona may reach, from `persona_connector.egressDomains`.
	 *
	 * Omitted means an empty list, which means nothing. Absence is denial here,
	 * and a persona that could reach anything because nobody passed a list would
	 * be the one default this file must not have.
	 */
	egressAllowlist?: readonly string[];
	personaVersionId: string;
	/** Gates are a workspace concept: a persona file cannot name approvers. */
	gateRules?: GateRule[];
	ttlSeconds?: number;
	now?: Date;
}

/**
 * The posture a persona gets when it declares none.
 *
 * `workspace-write` and `on-request`, which is to say: it may work inside the
 * project and it asks before anything reaches outside. The spec says runtimes
 * default conservatively and leaves the value open; this is that default made
 * concrete, and it is written here once so two runtimes cannot pick differently.
 */
export const DEFAULT_SANDBOX: SandboxPosture = "workspace-write";
export const DEFAULT_APPROVAL: ApprovalPosture = "on-request";

/** Four hours. Long enough to survive a flight, short enough to revoke within a shift. */
export const DEFAULT_TTL_SECONDS = 4 * 60 * 60;

const SANDBOX_VALUES: SandboxPosture[] = ["read-only", "workspace-write", "danger-full-access"];
const APPROVAL_VALUES: ApprovalPosture[] = ["untrusted", "on-failure", "on-request", "never"];

export function policyFromPersona(
	persona: PersonaPolicySource,
	options: PolicyFromPersonaOptions,
): CompiledPolicy {
	const permissions = persona.permissions ?? {};

	const draft: Omit<CompiledPolicy, "hash"> = {
		persona_version_id: options.personaVersionId,
		compiled_at: (options.now ?? new Date()).toISOString(),
		ttl_seconds: options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
		deny: strings(permissions.deny),
		allow: strings(permissions.allow),
		hard_limits: strings(persona.self_regulation?.hard_limits),
		prohibited_behaviors: strings(persona.character?.prohibited_behaviors),
		// From the caller rather than the persona document: the hosts a persona
		// may reach are a property of the workspace's connector grants, not of
		// the persona itself. The same persona pulled into two workspaces gets
		// each one's grants and neither one's by default.
		egress_allowlist: options.egressAllowlist ? [...options.egressAllowlist] : [],
		// An unrecognised value falls to the conservative default rather than
		// through. A persona that said `sandbox: "full"` (not a spec value) must
		// not end up with more freedom than one that said nothing.
		sandbox: oneOf(permissions.sandbox, SANDBOX_VALUES, DEFAULT_SANDBOX),
		approval: oneOf(permissions.approval, APPROVAL_VALUES, DEFAULT_APPROVAL),
		gate_rules: options.gateRules ?? [],
	};

	return { ...draft, hash: hashPolicy(draft) };
}

/**
 * True when two compilations of the same persona produced the same rules.
 *
 * Compares the hash, which covers every field including `compiled_at`, so this
 * is deliberately not the check for "same rules at a different time". It is the
 * check the daemon makes against what the workspace pushed: same hash, same
 * policy, no fetch needed.
 */
export function policiesAgree(a: CompiledPolicy, b: CompiledPolicy): boolean {
	return a.hash === b.hash;
}

function strings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
	return typeof value === "string" && (allowed as string[]).includes(value) ? (value as T) : fallback;
}
