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
 * The compiled form the daemon actually evaluates against.
 *
 * Separate from the wire shape above because it holds compiled regexes and
 * keyword sets, which do not serialise. `compile` builds it once per persona
 * version and the daemon caches it.
 */
export interface ExecutablePolicy {
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
export function compile(policy: CompiledPolicy): ExecutablePolicy {
	return {
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
				gate: {
					action_class: call.action_classes[0] ?? "external_write",
					required_approvals: 1,
					route: { roles: ["member"] },
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
