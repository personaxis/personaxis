/**
 * Precedence, proven over generated policies and calls rather than examples.
 *
 * The failure mode enforcement has is an input path nobody enumerated that
 * permits a call it should not. Examples only cover the paths someone thought
 * of, which is exactly the set that does not contain the bug.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ACTION_CLASSES, type ActionClass } from "../src/enforcement/action-classes.js";
import {
	compile,
	evaluate,
	type ApprovalPosture,
	type CompiledPolicy,
	type GateRule,
	type SandboxPosture,
} from "../src/enforcement/policy-compile.js";

const sandbox = fc.constantFrom<SandboxPosture>(
	"read-only",
	"workspace-write",
	"danger-full-access",
);
const approval = fc.constantFrom<ApprovalPosture>(
	"untrusted",
	"on-failure",
	"on-request",
	"never",
);
const actionClass = fc.constantFrom<ActionClass>(...ACTION_CLASSES);

/** Patterns kept simple so generation never produces a catastrophic regex. */
const pattern = fc.constantFrom("rm -rf", "curl", "push", "secret", "send", "drop", "sudo");

const gateRule: fc.Arbitrary<GateRule> = fc.record({
	action_class: actionClass,
	required_approvals: fc.integer({ min: 1, max: 5 }),
	route: fc.constant({ roles: ["member"] }),
	timeout_seconds: fc.integer({ min: 60, max: 7200 }),
});

const policyArb: fc.Arbitrary<CompiledPolicy> = fc.record({
	persona_version_id: fc.constant("pv_1"),
	hash: fc.constant("h"),
	compiled_at: fc.constant(new Date().toISOString()),
	ttl_seconds: fc.constant(3600),
	deny: fc.array(pattern, { maxLength: 3 }),
	allow: fc.array(pattern, { maxLength: 3 }),
	hard_limits: fc.array(fc.constantFrom("No unauthorized identity change.", "No spending."), {
		maxLength: 2,
	}),
	prohibited_behaviors: fc.array(fc.constantFrom("Fabricating sources or data."), {
		maxLength: 2,
	}),
	// E30: this was ABSENT, so five hundred generated policies a run were not
	// `CompiledPolicy` at all, and had been since the generator was written. Nothing
	// could say so: `fc.record` is typed by what you give it and the tests themselves
	// never met a type checker until E32. Compiling one now refuses it, which is how it
	// surfaced. Generated rather than empty, because an empty list reaches nothing and a
	// property that only ever saw the denying case is a property with one branch.
	egress_allowlist: fc.array(fc.constantFrom("api.github.com", "example.com"), {
		maxLength: 2,
	}),
	sandbox,
	approval,
	gate_rules: fc.array(gateRule, { maxLength: 3 }),
});

const callArb = fc.record({
	tool: fc.constantFrom("Bash", "WriteFile", "connector.gmail.send", "WebFetch"),
	args_text: fc.string({ maxLength: 60 }),
	action_classes: fc.uniqueArray(actionClass, { maxLength: 3 }),
});

describe("precedence holds over generated policies", () => {
	it("a matching deny beats everything, whatever else the policy says", () => {
		fc.assert(
			fc.property(policyArb, callArb, (policy, call) => {
				const executable = compile(policy);
				const subject = `${call.tool} ${call.args_text}`;
				const matches = executable.deny.some((re) => re.test(subject));

				const decision = evaluate(executable, call);
				if (matches) expect(decision.verdict).toBe("deny");
			}),
			{ numRuns: 500 },
		);
	});

	it("never opens a gate for a call a deny already refused", () => {
		// The gate branch holding a hook open is the mechanism behind the visible
		// freeze. Opening one for a denied call would ask a person to approve
		// something that was never going to run.
		fc.assert(
			fc.property(policyArb, callArb, (policy, call) => {
				const executable = compile(policy);
				const subject = `${call.tool} ${call.args_text}`;
				if (!executable.deny.some((re) => re.test(subject))) return;

				expect(evaluate(executable, call).verdict).not.toBe("gate");
			}),
			{ numRuns: 500 },
		);
	});

	it("an allow never overturns a deny, however the two are ordered", () => {
		fc.assert(
			fc.property(policyArb, callArb, (policy, call) => {
				// Force the overlap the property is about: the same pattern in both
				// lists is the case someone eventually writes by accident.
				const overlapping: CompiledPolicy = { ...policy, allow: [...policy.deny] };
				const executable = compile(overlapping);
				const subject = `${call.tool} ${call.args_text}`;
				if (!executable.deny.some((re) => re.test(subject))) return;

				expect(evaluate(executable, call).verdict).toBe("deny");
			}),
			{ numRuns: 500 },
		);
	});

	it("a read-only persona never allows a call that writes", () => {
		fc.assert(
			fc.property(policyArb, callArb, (policy, call) => {
				const readOnly: CompiledPolicy = { ...policy, sandbox: "read-only" };
				const writes = call.action_classes.some((c) =>
					["external_write", "file_delete", "spend"].includes(c),
				);
				if (!writes) return;

				expect(evaluate(compile(readOnly), call).verdict).not.toBe("allow");
			}),
			{ numRuns: 500 },
		);
	});

	it("is deterministic: the same policy and call always decide the same way", () => {
		fc.assert(
			fc.property(policyArb, callArb, (policy, call) => {
				const first = evaluate(compile(policy), call);
				const second = evaluate(compile(policy), call);
				expect(first).toEqual(second);
			}),
			{ numRuns: 300 },
		);
	});

	it("always reaches a verdict, and always names the rule that decided", () => {
		// A call with no answer would be a hole: the daemon has to do something,
		// and without a verdict it would have to guess.
		fc.assert(
			fc.property(policyArb, callArb, (policy, call) => {
				const decision = evaluate(compile(policy), call);
				expect(["allow", "deny", "gate"]).toContain(decision.verdict);
				expect(decision.rule.length).toBeGreaterThan(0);
			}),
			{ numRuns: 500 },
		);
	});

	it("compiles a well-formed policy without throwing, invalid regex included", () => {
		// Narrowed from "any policy" by E30, and the narrowing is the point rather than a
		// retreat. A bad PATTERN must never take a policy down: that would stop a persona
		// working over a typo, so it compiles to something that matches nothing. A bad
		// SHAPE is the opposite case and now throws, because the alternative was measured
		// and it is a guard failing mid-call in the persona's own voice.
		fc.assert(
			fc.property(fc.array(fc.string(), { maxLength: 4 }), (sources) => {
				const policy: CompiledPolicy = {
					persona_version_id: "pv",
					hash: "h",
					compiled_at: new Date().toISOString(),
					ttl_seconds: 3600,
					deny: sources,
					allow: sources,
					hard_limits: [],
					prohibited_behaviors: [],
					egress_allowlist: [],
					sandbox: "workspace-write",
					approval: "never",
					gate_rules: [],
				};
				expect(() => compile(policy)).not.toThrow();
			}),
			{ numRuns: 300 },
		);
	});
});
