/**
 * The enforcement decision: whether a tool call runs, is refused, or waits for
 * a person.
 *
 * This is the load-bearing part of the product. A prompt that says "never email
 * a customer without approval" is a request; it can be argued out of, confused
 * out of, or injected out of. A gate at the tool call is not a request, because
 * the call does not execute. Everything else the workspace does is presentation
 * on top of this function returning the right answer.
 *
 * Two properties it must have, and the tests are written against them rather
 * than against examples:
 *
 *   Precedence is absolute. A deny beats everything, including an approved
 *   gate, and a gate for a denied call never opens.
 *
 *   Evaluation is pure and fast. The budget is 150 ms at p95 for allow and
 *   deny, which is why every regex is compiled once in `compile` and `evaluate`
 *   compiles nothing. Above that budget people turn enforcement off, which
 *   kills the product more surely than any competitor.
 */

import { createHash } from "node:crypto";
import { checkEgressIn } from "./egress.js";

import type { SandboxPosture } from "../security/consent.js";

import type { ActionClass } from "./action-classes.js";

// SandboxPosture is not redefined here. The same three postures already have an
// owner in security/consent, and a second declaration would be one concept with
// two definitions that drift the day one gains a value.
export type { SandboxPosture };

export type ApprovalPosture = "untrusted" | "on-failure" | "on-request" | "never";

export interface GateRule {
	action_class: ActionClass;
	required_approvals: number;
	route: { roles?: string[]; user_ids?: string[] };
	timeout_seconds: number;
}

/** A persona's limits, in the form the decision needs them. */
export interface CompiledPolicy {
	persona_version_id: string;
	/** sha256 of this object's canonical JSON without the hash. */
	hash: string;
	compiled_at: string;
	ttl_seconds: number;
	deny: string[];
	allow: string[];
	hard_limits: string[];
	prohibited_behaviors: string[];
	/**
	 * Hosts this persona may reach, from its connector grants.
	 *
	 * Absence is denial: a persona with an empty list reaches nothing. That is
	 * the only default that makes a new connector safe before anyone has thought
	 * about which hosts it needs.
	 */
	egress_allowlist: string[];
	sandbox: SandboxPosture;
	approval: ApprovalPosture;
	gate_rules: GateRule[];
}

/**
 * The key that says this came out of `compile()`. Real at runtime, and not exported.
 *
 * E30: the same shape `E13` uses for taint, and here for the same reason. This type was
 * structural, so anything with the right fields WAS one as far as the compiler was
 * concerned, and two ways of getting a wrong one were open. Somebody builds it by hand,
 * which is what happened while measuring `E28`: a policy with `persona_id` where
 * `persona_version_id` belongs and no `ttl_seconds` made a guard throw
 * `Cannot read properties of undefined (reading 'length')`, the cascade contained it by
 * denying, and the turn ended with the persona saying it could not access the
 * repository. From outside that is indistinguishable from a model that will not work,
 * and it cost twenty minutes to tell apart. Or it arrives off a wire: this type holds
 * `RegExp[]` and a `Map`, neither of which survives JSON, so a parsed policy has the
 * right shape for TypeScript and explodes on every call.
 *
 * A module-scoped `Symbol()` is inferred as a `unique symbol` and exists at runtime, so
 * the brand is enforced by the compiler AND is really there. Not exporting it is what
 * closes both doors at once: nothing outside this file can write the property.
 */
const COMPILED = Symbol("personaxis.compiled-policy");

/**
 * The compiled form the daemon actually evaluates against.
 *
 * Separate from the wire shape above because it holds compiled regexes and
 * keyword sets, which do not serialise. `compile` builds it once per persona
 * version and the daemon caches it.
 */
export interface ExecutablePolicy {
	/** Phantom at the type level, present at runtime. See `COMPILED`. */
	readonly [COMPILED]: true;
	policy: CompiledPolicy;
	deny: RegExp[];
	allow: RegExp[];
	/** One keyword set per hard limit, in the order they appear. */
	hardLimitKeywords: string[][];
	prohibitedKeywords: string[][];
	gatesByClass: Map<ActionClass, GateRule>;
}

export type PolicyDecision =
	| { verdict: "allow"; rule: string }
	| { verdict: "deny"; rule: string; reason: string }
	| { verdict: "gate"; rule: string; gate: GateRule };

/**
 * The subject of a decision.
 *
 * Not the engine's ToolCall, which is a request with an id and structured
 * arguments. This is what the policy reasons about: a name, the arguments as
 * text, and what the call is about to do.
 */
export interface PolicyCall {
	tool: string;
	args_text: string;
	action_classes: ActionClass[];
}

/** Classes that write, for the sandbox check. */
const WRITING_CLASSES: ActionClass[] = ["external_write", "file_delete", "spend"];

/**
 * Words too common to carry meaning in a limit.
 *
 * A limit reduced to nothing but these would match every call, turning one
 * careless line in a persona into a policy that refuses everything.
 */
const STOP_WORDS = new Set([
	"no", "not", "never", "the", "a", "an", "of", "to", "in", "on", "for", "and",
	"or", "with", "without", "any", "all", "its", "his", "her", "their", "real",
	"claim", "make", "do", "does", "is", "are", "be", "that", "this", "it",
]);

/**
 * Reduces a limit written for a person into the words worth matching.
 *
 * Done at compile time, never per call: this is string work, and the budget
 * above does not survive doing it on the hot path.
 */
export function keywordsFor(limit: string): string[] {
	return [
		...new Set(
			limit
				.toLowerCase()
				.split(/[^a-z0-9_]+/)
				.filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
		),
	];
}

/**
 * Compiles a policy for evaluation.
 *
 * An invalid regex in a persona does not throw and does not silently vanish: it
 * becomes a pattern that matches nothing, and the reason is that a persona with
 * one bad deny line should lose that line, not stop being enforceable.
 */
/**
 * What a policy has to have before anything is allowed to evaluate against it.
 *
 * E30: `compile` used to take whatever it was handed. The fields are listed by what the
 * evaluator DEREFERENCES rather than by what the interface declares, because a missing
 * declared field that nothing reads is a tidiness problem and a missing dereferenced one
 * is a guard that throws mid-call.
 */
const REQUIRED_LISTS = [
	"deny",
	"allow",
	"hard_limits",
	"prohibited_behaviors",
	"egress_allowlist",
	"gate_rules",
] as const satisfies readonly (keyof CompiledPolicy)[];

const REQUIRED_TEXT = [
	"persona_version_id",
	"hash",
	"compiled_at",
	"sandbox",
	"approval",
] as const satisfies readonly (keyof CompiledPolicy)[];

/**
 * Everything wrong with a policy, in one list.
 *
 * All of them rather than the first, because a shape somebody is building by hand is
 * usually wrong in more than one place, and an API that reveals one fault per attempt
 * teaches people that it is hostile rather than that they are close.
 */
function faultsIn(policy: CompiledPolicy): string[] {
	const faults: string[] = [];
	const seen = policy as unknown as Record<string, unknown>;

	for (const field of REQUIRED_LISTS) {
		if (!Array.isArray(seen[field])) faults.push(`${field} must be an array`);
	}
	for (const field of REQUIRED_TEXT) {
		if (typeof seen[field] !== "string") faults.push(`${field} must be a string`);
	}
	if (typeof seen["ttl_seconds"] !== "number") faults.push("ttl_seconds must be a number");

	return faults;
}

/**
 * Turns a policy into the only thing the gate will evaluate against.
 *
 * Throws rather than returning a result, and fails at the door rather than in a guard.
 * A policy that cannot be compiled is not a policy, and the alternative was measured:
 * the fault surfaces deep inside the cascade, gets contained by the rule that a guard
 * which did not decide has not allowed, and reaches the person as the persona refusing
 * to work. Failing here names it instead.
 */
export function compile(policy: CompiledPolicy): ExecutablePolicy {
	const faults = faultsIn(policy);
	if (faults.length > 0) {
		throw new Error(`this policy cannot be compiled: ${faults.join("; ")}`);
	}

	return {
		[COMPILED]: true,
		policy,
		deny: compilePatterns(policy.deny),
		allow: compilePatterns(policy.allow),
		hardLimitKeywords: policy.hard_limits.map(keywordsFor),
		prohibitedKeywords: policy.prohibited_behaviors.map(keywordsFor),
		gatesByClass: new Map(policy.gate_rules.map((rule) => [rule.action_class, rule])),
	};
}

function compilePatterns(sources: string[]): RegExp[] {
	return sources.map((source) => {
		try {
			return new RegExp(source, "i");
		} catch {
			// Matches nothing. A pattern that threw here would take the whole
			// policy down, and a policy that fails to load fails closed, which
			// would stop a persona working over a typo.
			return /(?!)/;
		}
	});
}

/**
 * Decides. First match wins, in this order, and the order is the product.
 */
export function evaluate(executable: ExecutablePolicy, call: PolicyCall): PolicyDecision {
	const subject = `${call.tool} ${call.args_text}`;
	const { policy } = executable;

	// 1. Deny regex. Nothing overrides this, including an approved gate: the
	//    gate never opens, so there is nothing to approve.
	for (let i = 0; i < executable.deny.length; i++) {
		if (executable.deny[i].test(subject)) {
			return {
				verdict: "deny",
				rule: `deny:${policy.deny[i]}`,
				reason: `permissions.deny matched: ${policy.deny[i]}`,
			};
		}
	}

	// 2. Hard limits. Absolute, and they outrank staying in character.
	for (let i = 0; i < executable.hardLimitKeywords.length; i++) {
		if (matchesKeywords(subject, executable.hardLimitKeywords[i])) {
			return {
				verdict: "deny",
				rule: `hard_limit:${i}`,
				reason: policy.hard_limits[i],
			};
		}
	}

	// 3. Egress. Before the postures, because where data goes is not a matter of
	//    posture: a read-only sandbox does not stop a persona from POSTing what
	//    it read, and a persona doing exactly what it was asked can still be
	//    sending it somewhere a prompt injection chose.
	const egress = checkEgressIn(subject, policy.egress_allowlist ?? []);
	if (!egress.allowed) {
		return {
			verdict: "deny",
			rule: "egress_allowlist",
			reason: egress.reason,
		};
	}

	// 4. Prohibited behaviours.
	for (let i = 0; i < executable.prohibitedKeywords.length; i++) {
		if (matchesKeywords(subject, executable.prohibitedKeywords[i])) {
			return {
				verdict: "deny",
				rule: `prohibited_behavior:${i}`,
				reason: policy.prohibited_behaviors[i],
			};
		}
	}

	// 5. Sandbox posture.
	if (policy.sandbox === "read-only") {
		const writing = call.action_classes.find((cls) => WRITING_CLASSES.includes(cls));
		if (writing) {
			return {
				verdict: "deny",
				rule: "sandbox:read-only",
				reason: `this persona is read-only and the call would ${writing.replace("_", " ")}`,
			};
		}
	}
	if (policy.sandbox === "workspace-write" && call.action_classes.includes("external_write")) {
		// Unless a gate covers it, which the next step decides. Reaching outside
		// the workspace is exactly what this posture exists to hold back.
		if (!executable.gatesByClass.has("external_write")) {
			return {
				verdict: "deny",
				rule: "sandbox:workspace-write",
				reason: "this persona may write inside the workspace, and the call reaches outside it",
			};
		}
	}

	// 5. Declared gates, which produce a pause rather than a refusal.
	for (const cls of call.action_classes) {
		const gate = executable.gatesByClass.get(cls);
		if (gate) return { verdict: "gate", rule: `gate:${cls}`, gate };
	}

	// 6. Allow regex.
	for (let i = 0; i < executable.allow.length; i++) {
		if (executable.allow[i].test(subject)) {
			return { verdict: "allow", rule: `allow:${policy.allow[i]}` };
		}
	}

	// 7. The default the persona declared.
	switch (policy.approval) {
		case "never":
		case "on-failure":
			return { verdict: "allow", rule: `approval:${policy.approval}` };
		case "on-request":
		case "untrusted":
			return {
				verdict: "gate",
				rule: `approval:${policy.approval}`,
				// Invented, because the persona asked for a person and no rule said who.
				// So it invents as little as possible.
				//
				// The route is EMPTY, meaning anyone entitled to act here. It used to name
				// `member`, which reads as a sensible default and is not one: it locked out
				// the owner of the workspace, and in a personal workspace, where there are
				// no members, it made the gate unanswerable by anybody. A posture that says
				// "ask a person" means a person, not a rank.
				gate: {
					action_class: call.action_classes[0] ?? "external_write",
					required_approvals: 1,
					route: {},
					timeout_seconds: 3600,
				},
			};
	}
}

/**
 * A limit matches when every one of its keywords appears.
 *
 * All rather than any, because a limit is a sentence: "no persistent memory
 * write without policy pass" should not fire on any call that mentions
 * "memory". A limit that reduced to no keywords matches nothing, so a vague
 * line in a persona cannot become a policy that refuses everything.
 */
function matchesKeywords(subject: string, keywords: string[]): boolean {
	if (keywords.length === 0) return false;
	const haystack = subject.toLowerCase();
	return keywords.every((word) => haystack.includes(word));
}

/** Content hash of a policy, so a daemon can tell whether its cache is current. */
export function hashPolicy(policy: Omit<CompiledPolicy, "hash">): string {
	const canonical = JSON.stringify(policy, Object.keys(policy).sort());
	return createHash("sha256").update(canonical).digest("hex");
}

/** True when a cached policy is too old to trust. */
export function isExpired(policy: CompiledPolicy, now: Date = new Date()): boolean {
	const compiledAt = Date.parse(policy.compiled_at);
	// An unparseable timestamp counts as expired. Treating it as fresh would
	// make a corrupted cache entry outlive its policy.
	if (Number.isNaN(compiledAt)) return true;
	return now.getTime() - compiledAt > policy.ttl_seconds * 1000;
}
