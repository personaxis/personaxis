/**
 * "Deny regex imbatible" — the DONE condition of phase 2, made checkable.
 *
 * The plan names the failure mode this rules out: **the input nobody enumerated that lets a
 * forbidden call through.** Example-based tests cannot rule that out, because the examples
 * are exactly the enumeration. So the properties below quantify over the thing an attacker
 * controls (the argument text, the surrounding policy, the postures) and hold the one
 * sentence the product sells: if a deny pattern matches, the call does not run. Nothing
 * overrides it, and no arrangement of the rest of the policy makes it negotiable.
 *
 * These properties are about PRECEDENCE and EVASION, not about regex quality. A deny that
 * fails to describe what its author meant is a persona problem; a deny that describes it and
 * is then overridden is ours.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
	compile,
	evaluate,
	type ActionClass,
	type ApprovalPosture,
	type CompiledPolicy,
	type GateRule,
	type SandboxPosture,
} from "../../src/enforcement/policy-compile.js";
import { NUM_RUNS, PROP_TIMEOUT } from "./arbitraries.js";

const ACTION_CLASSES: ActionClass[] = [
	"read",
	"local_write",
	"external_write",
	"file_delete",
	"spend",
	"network",
];

const sandboxArb = fc.constantFrom<SandboxPosture>("read-only", "workspace-write", "danger-full-access");
const approvalArb = fc.constantFrom<ApprovalPosture>("untrusted", "on-failure", "on-request", "never");

const gateRuleArb: fc.Arbitrary<GateRule> = fc.record({
	action_class: fc.constantFrom(...ACTION_CLASSES),
	required_approvals: fc.integer({ min: 1, max: 3 }),
	route: fc.constant({}),
	timeout_seconds: fc.integer({ min: 30, max: 3600 }),
});

/**
 * Everything about a policy EXCEPT its deny list.
 *
 * Generated freely, including the arrangements somebody would reach for to get a call
 * through: a matching allow, the loosest sandbox, approval set to never, a gate that would
 * otherwise open. If any of those could beat a deny, these properties find it.
 */
function policyAroundDeny(deny: string[], allow?: string[]): fc.Arbitrary<CompiledPolicy> {
	return fc.record({
		// Generated, and `.*` is in the pool on purpose: the first thing somebody tries in
		// order to get a call through is allowing it explicitly, and blanket-allowing
		// everything is the strongest form of that.
		allow: allow ? fc.constant(allow) : fc.subarray([".*", "^bash", "rm.*", "^curl"], { minLength: 0 }),
		hard_limits: fc.array(fc.constantFrom("no unauthorised identity change", "no persistent memory write"), {
			maxLength: 2,
		}),
		prohibited_behaviors: fc.array(fc.constantFrom("marketing copy", "legal advice"), { maxLength: 2 }),
		egress_allowlist: fc.array(fc.constantFrom("api.example.com", "*.googleapis.com"), { maxLength: 2 }),
		sandbox: sandboxArb,
		approval: approvalArb,
		gate_rules: fc.array(gateRuleArb, { maxLength: 3 }),
	}).map((rest) => ({
		persona_version_id: "v1",
		hash: "0".repeat(64),
		compiled_at: new Date(0).toISOString(),
		ttl_seconds: 300,
		deny,
		...rest,
	}));
}

/** Text that surrounds a forbidden command without altering it. */
const noiseArb = fc.stringMatching(/^[a-zA-Z0-9 _|&;.>/-]{0,40}$/);

describe("PB-deny-1: a matching deny is final", () => {
	it(
		"denies whatever the rest of the policy says",
		() => {
			fc.assert(
				fc.property(
					policyAroundDeny(["rm\\s+-rf"]),
					noiseArb,
					noiseArb,
					fc.array(fc.constantFrom(...ACTION_CLASSES), { maxLength: 3 }),
					(policy, before, after, classes) => {
						const decision = evaluate(compile(policy), {
							tool: "bash",
							args_text: `${before}rm -rf /tmp/x${after}`,
							action_classes: classes,
						});

						expect(decision.verdict).toBe("deny");
						// And it names the rule. A refusal that does not say which line
						// refused leaves an operator editing a policy by guesswork.
						if (decision.verdict === "deny") expect(decision.rule).toContain("deny:");
					},
				),
				{ numRuns: NUM_RUNS },
			);
		},
		PROP_TIMEOUT,
	);

	it(
		"beats an allow for the very same pattern",
		() => {
			// The arrangement somebody reaches for first: allow it explicitly. Precedence is
			// absolute, so ordering the lists differently changes nothing.
			fc.assert(
				fc.property(policyAroundDeny(["curl\\s"], ["curl\\s", ".*"]), noiseArb, (policy, noise) => {
					const decision = evaluate(compile(policy), {
						tool: "bash",
						args_text: `curl https://example.com ${noise}`,
						action_classes: ["network"],
					});
					expect(decision.verdict).toBe("deny");
				}),
				{ numRuns: NUM_RUNS },
			);
		},
		PROP_TIMEOUT,
	);

	it(
		"is not softened by the loosest posture or by a gate that would open",
		() => {
			// `danger-full-access` + `never` + a gate on every class is the most permissive
			// policy expressible. A deny still wins, because the gate never opens: there is
			// nothing to approve.
			const policy: CompiledPolicy = {
				persona_version_id: "v1",
				hash: "0".repeat(64),
				compiled_at: new Date(0).toISOString(),
				ttl_seconds: 300,
				deny: ["secrets"],
				allow: [".*"],
				hard_limits: [],
				prohibited_behaviors: [],
				egress_allowlist: ["*"],
				sandbox: "danger-full-access",
				approval: "never",
				gate_rules: ACTION_CLASSES.map((action_class) => ({
					action_class,
					required_approvals: 1,
					route: {},
					timeout_seconds: 60,
				})),
			};

			fc.assert(
				fc.property(noiseArb, fc.array(fc.constantFrom(...ACTION_CLASSES), { maxLength: 3 }), (noise, classes) => {
					const decision = evaluate(compile(policy), {
						tool: "bash",
						args_text: `cat ${noise}secrets.env`,
						action_classes: classes,
					});
					expect(decision.verdict).toBe("deny");
				}),
				{ numRuns: NUM_RUNS },
			);
		},
		PROP_TIMEOUT,
	);
});

describe("PB-deny-2: position and company do not matter", () => {
	it(
		"matches wherever the rule sits in the list",
		() => {
			// A deny that only worked when it happened to be first would be a rule whose
			// meaning depended on the order somebody typed it in.
			fc.assert(
				fc.property(
					fc.array(fc.constantFrom("nothing-to-match-here", "zzz-unused"), { maxLength: 5 }),
					fc.integer({ min: 0, max: 5 }),
					(padding, at) => {
						const deny = [...padding];
						deny.splice(Math.min(at, deny.length), 0, "shutdown");

						const policy: CompiledPolicy = {
							persona_version_id: "v1",
							hash: "0".repeat(64),
							compiled_at: new Date(0).toISOString(),
							ttl_seconds: 300,
							deny,
							allow: [],
							hard_limits: [],
							prohibited_behaviors: [],
							egress_allowlist: ["*"],
							sandbox: "workspace-write",
							approval: "never",
							gate_rules: [],
						};

						expect(evaluate(compile(policy), {
							tool: "bash",
							args_text: "shutdown -h now",
							action_classes: ["local_write"],
						}).verdict).toBe("deny");
					},
				),
				{ numRuns: NUM_RUNS },
			);
		},
		PROP_TIMEOUT,
	);

	it(
		"keeps enforcing when a NEIGHBOURING pattern is invalid",
		() => {
			// A typo in one line must lose that line, not the policy. The opposite failure is
			// the dangerous one: a policy that fails to compile and is treated as absent.
			fc.assert(
				fc.property(fc.constantFrom("[", "(?<", "*", "a{2,1}", "\\"), (broken) => {
					const policy: CompiledPolicy = {
						persona_version_id: "v1",
						hash: "0".repeat(64),
						compiled_at: new Date(0).toISOString(),
						ttl_seconds: 300,
						deny: [broken, "rm\\s+-rf"],
						allow: [],
						hard_limits: [],
						prohibited_behaviors: [],
						egress_allowlist: ["*"],
						sandbox: "workspace-write",
						approval: "never",
						gate_rules: [],
					};

					expect(() => compile(policy)).not.toThrow();
					expect(evaluate(compile(policy), {
						tool: "bash",
						args_text: "rm -rf /",
						action_classes: ["file_delete"],
					}).verdict).toBe("deny");
				}),
				{ numRuns: NUM_RUNS },
			);
		},
		PROP_TIMEOUT,
	);

	it(
		"an invalid pattern refuses NOTHING on its own",
		() => {
			// The other way a broken line can go wrong, and the one the test above cannot
			// see: compiled to something that matches everything, a typo becomes a policy
			// that refuses all work. It would look like enforcement working very well, right
			// up to the point somebody turns the persona off to get anything done.
			//
			// A mutation to `/.*/ ` passed every other property here. This is the one that
			// caught it.
			fc.assert(
				fc.property(
					fc.constantFrom("[", "(?<", "*", "a{2,1}", "\\", "(", "+"),
					fc.stringMatching(/^[a-z0-9 _.\/-]{1,30}$/),
					(broken, harmless) => {
						const policy: CompiledPolicy = {
							persona_version_id: "v1",
							hash: "0".repeat(64),
							compiled_at: new Date(0).toISOString(),
							ttl_seconds: 300,
							deny: [broken],
							allow: [],
							hard_limits: [],
							prohibited_behaviors: [],
							egress_allowlist: ["*"],
							sandbox: "workspace-write",
							approval: "never",
							gate_rules: [],
						};

						const decision = evaluate(compile(policy), {
							tool: "ls",
							args_text: `ls ${harmless}`,
							action_classes: ["read"],
						});
						if (decision.verdict === "deny") expect(decision.rule).not.toContain("deny:");
					},
				),
				{ numRuns: NUM_RUNS },
			);
		},
		PROP_TIMEOUT,
	);
});

describe("PB-deny-3: the subject cannot be escaped", () => {
	it(
		"sees the forbidden text whichever tool carries it",
		() => {
			// The subject is `tool` plus argument text. Moving a command to a different tool
			// is the cheapest evasion there is, and it must not work: the pattern describes
			// what may not happen, not who may not ask for it.
			fc.assert(
				fc.property(
					fc.stringMatching(/^[a-z_]{1,12}$/),
					noiseArb,
					(tool, noise) => {
						const policy = {
							persona_version_id: "v1",
							hash: "0".repeat(64),
							compiled_at: new Date(0).toISOString(),
							ttl_seconds: 300,
							deny: ["\\.ssh/id_rsa"],
							allow: [".*"],
							hard_limits: [],
							prohibited_behaviors: [],
							egress_allowlist: ["*"],
							sandbox: "danger-full-access" as SandboxPosture,
							approval: "never" as ApprovalPosture,
							gate_rules: [],
						};

						expect(evaluate(compile(policy), {
							tool,
							args_text: `${noise} ~/.ssh/id_rsa`,
							action_classes: ["read"],
						}).verdict).toBe("deny");
					},
				),
				{ numRuns: NUM_RUNS },
			);
		},
		PROP_TIMEOUT,
	);

	it(
		"is case-insensitive, so shouting does not get through",
		() => {
			fc.assert(
				fc.property(fc.constantFrom("RM -RF /", "Rm -Rf /", "rM -rF /"), (shouted) => {
					const policy = {
						persona_version_id: "v1",
						hash: "0".repeat(64),
						compiled_at: new Date(0).toISOString(),
						ttl_seconds: 300,
						deny: ["rm\\s+-rf"],
						allow: [".*"],
						hard_limits: [],
						prohibited_behaviors: [],
						egress_allowlist: ["*"],
						sandbox: "danger-full-access" as SandboxPosture,
						approval: "never" as ApprovalPosture,
						gate_rules: [],
					};

					expect(evaluate(compile(policy), {
						tool: "bash",
						args_text: shouted,
						action_classes: ["file_delete"],
					}).verdict).toBe("deny");
				}),
				{ numRuns: NUM_RUNS },
			);
		},
		PROP_TIMEOUT,
	);

	it(
		"never throws, whatever arrives in the argument text",
		() => {
			// A crash in the decision is a fail-open in every caller that catches broadly.
			// The input here is fully arbitrary on purpose: control characters, lone
			// surrogates, regex metacharacters, the lot.
			fc.assert(
				fc.property(fc.string(), fc.string(), (tool, args) => {
					const policy = {
						persona_version_id: "v1",
						hash: "0".repeat(64),
						compiled_at: new Date(0).toISOString(),
						ttl_seconds: 300,
						deny: ["rm\\s+-rf", "\\$\\(", "[<>]\\("],
						allow: [],
						hard_limits: ["no unauthorised identity change"],
						prohibited_behaviors: ["marketing copy"],
						egress_allowlist: ["api.example.com"],
						sandbox: "read-only" as SandboxPosture,
						approval: "untrusted" as ApprovalPosture,
						gate_rules: [],
					};

					const decision = evaluate(compile(policy), {
						tool,
						args_text: args,
						action_classes: ["read"],
					});
					// Exactly one verdict, always. "No decision" is the shape that becomes a
					// fail-open one refactor later.
					expect(["allow", "deny", "gate"]).toContain(decision.verdict);
				}),
				{ numRuns: NUM_RUNS },
			);
		},
		PROP_TIMEOUT,
	);
});

describe("PB-deny-4: it refuses only what it was told to", () => {
	it(
		"does not deny a call no pattern describes",
		() => {
			// The other half of "unbeatable", and the one that keeps it usable. A deny list
			// that refused everything would pass every test above and be worthless, and a
			// persona that refuses ordinary work is one people turn off.
			const policy = {
				persona_version_id: "v1",
				hash: "0".repeat(64),
				compiled_at: new Date(0).toISOString(),
				ttl_seconds: 300,
				deny: ["rm\\s+-rf"],
				allow: ["^ls", "^cat"],
				hard_limits: [],
				prohibited_behaviors: [],
				egress_allowlist: [],
				sandbox: "read-only" as SandboxPosture,
				approval: "never" as ApprovalPosture,
				gate_rules: [],
			};

			fc.assert(
				fc.property(fc.stringMatching(/^[a-z0-9_.\/-]{1,20}$/), (path) => {
					const decision = evaluate(compile(policy), {
						tool: "ls",
						args_text: `ls ${path}`,
						action_classes: ["read"],
					});
					expect(decision.verdict).not.toBe("deny");
				}),
				{ numRuns: NUM_RUNS },
			);
		},
		PROP_TIMEOUT,
	);

	it(
		"an empty deny list denies nothing by itself",
		() => {
			fc.assert(
				fc.property(noiseArb, (noise) => {
					const policy = {
						persona_version_id: "v1",
						hash: "0".repeat(64),
						compiled_at: new Date(0).toISOString(),
						ttl_seconds: 300,
						deny: [],
						allow: [".*"],
						hard_limits: [],
						prohibited_behaviors: [],
						egress_allowlist: ["*"],
						sandbox: "danger-full-access" as SandboxPosture,
						approval: "never" as ApprovalPosture,
						gate_rules: [],
					};

					const decision = evaluate(compile(policy), {
						tool: "ls",
						args_text: noise,
						action_classes: ["read"],
					});
					if (decision.verdict === "deny") expect(decision.rule).not.toContain("deny:");
				}),
				{ numRuns: NUM_RUNS },
			);
		},
		PROP_TIMEOUT,
	);
});
