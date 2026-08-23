/**
 * What the gate promises, checked.
 *
 * The load-bearing one is the first group: no arrangement of guards produces a
 * permission. That is a claim about every possible guard, so most of it lives in the
 * property file. What is here is the behaviour a person needs to be able to read.
 */

import { describe, expect, it } from "vitest";

import {
	GuardSet,
	ask,
	capabilityGuard,
	decide,
	deny,
	examine,
	freezeCall,
	identityGuard,
	meet,
	postureFor,
	requirePolicy,
	runGuards,
	type Guard,
	type IdentityPolicy,
} from "../src/gate/index.js";
import { compile, type CompiledPolicy } from "../src/enforcement/policy-compile.js";
import type { Envelope } from "../src/envelopes.js";

const envelope = (mean: number, min: number, max: number): Envelope =>
	({ mean, min, max, range: Math.max(max - mean, mean - min) }) as Envelope;

// Bands are absolute points on the scale, not thirds of the envelope, so a
// coordinate declared inside a single band cannot cross one at all. `patience` spans
// two on purpose; a virtue pinned high, as honesty is, has nothing to cross and that
// is the spec working rather than a gap in the fixture.
const policy: IdentityPolicy = {
	envelopes: {
		"affect.mood.tone": envelope(0, -0.4, 0.4),
		"character.virtues.patience": envelope(0.5, 0.2, 0.9),
		"personality.traits.humour": envelope(0.5, 0.2, 0.8),
	},
	current: {
		"affect.mood.tone": 0,
		"character.virtues.patience": 0.7,
		"personality.traits.humour": 0.5,
	},
	postures: {
		"affect": "autonomous",
		"character": "locked",
		"personality": "review",
	},
};

function call(overrides: Partial<Parameters<typeof freezeCall>[0]> = {}) {
	return freezeCall({
		tool: "shell",
		argsText: "ls",
		turn: "t1",
		callId: "fixed",
		...overrides,
	});
}

const silent: Guard = { name: "silent", check: () => undefined };
const refuses: Guard = { name: "refuses", check: () => deny("r", "because") };
const asks: Guard = { name: "asks", check: () => ask("a", "please look") };

describe("no arrangement of guards produces a permission", () => {
	it("has no way to spell an allow", () => {
		// This is the guarantee, and it is the compiler's. The assertion below is a
		// formality: what matters is that `{ reduce: "allow" }` does not type-check, so
		// no guard anybody writes later can grant anything.
		const outcome = deny("r", "because");
		expect(outcome && "reduce" in outcome && outcome.reduce).toBe("deny");
	});

	it("lets a denial win over an ask whichever came first", () => {
		expect(runGuards([asks, refuses], call()).verdict).toBe("deny");
		expect(runGuards([refuses, asks], call()).verdict).toBe("deny");
	});

	it("allows only when nobody objected", () => {
		expect(runGuards([silent, silent], call()).verdict).toBe("allow");
	});

	it("keeps every reason, not just the one that won", () => {
		// An operator widening the first reason needs to know the second is still
		// there, or they widen a scope and are surprised the call still does not run.
		const result = runGuards([refuses, asks], call());

		expect(result.contributions.map((c) => c.guard)).toEqual(["refuses", "asks"]);
	});

	it("treats a guard that throws as a denial that names itself", () => {
		// A guard that broke did not decide. Reading a crash as silence is how an
		// exception becomes a permission.
		const broken: Guard = {
			name: "broken",
			check: () => {
				throw new Error("regex blew up");
			},
		};

		const result = runGuards([broken], call());

		expect(result.verdict).toBe("deny");
		expect(result.contributions[0]!.reason).toContain("did not decide");
	});

	it("meets pairwise the way the order says", () => {
		expect(meet("allow", "ask")).toBe("ask");
		expect(meet("ask", "deny")).toBe("deny");
		expect(meet("allow", "allow")).toBe("allow");
	});
});

describe("the call is frozen before anyone decides", () => {
	it("cannot be edited by a guard holding it", () => {
		// Four views have to agree about what was asked: the record, the audit, the
		// interface and the executor. A guard that could rewrite the arguments makes
		// somebody approve one command while another one runs.
		const frozen = call({ argsText: "rm -rf /" });

		expect(() => {
			(frozen as { argsText: string }).argsText = "ls";
		}).toThrow();
	});

	it("freezes the action classes too, not just the top level", () => {
		const frozen = call({ actionClasses: ["external_write"] });

		expect(() => {
			(frozen.actionClasses as string[]).push("spend");
		}).toThrow();
	});

	it("gives two identical calls in one turn different identities", () => {
		// Ordinary, and if they shared an id they would merge in the record into one
		// call with two verdicts.
		const first = freezeCall({ tool: "shell", argsText: "ls", turn: "t1" });
		const second = freezeCall({ tool: "shell", argsText: "ls", turn: "t1" });

		expect(first.callId).not.toBe(second.callId);
	});

	it("carries the identity through to the decision, refused or not", () => {
		// A call that never ran still has an identity, which is what makes a refusal
		// something a workspace can show and an operator can point at.
		const frozen = call({ callId: "abc123" });

		expect(runGuards([refuses], frozen).callId).toBe("abc123");
	});
});

describe("the second axis asks whether this leaves me being who I am", () => {
	it("refuses a call that would leave the declared envelope", () => {
		const guard = identityGuard(policy);

		const outcome = guard(call({ effects: [{ field: "affect.mood.tone", to: 0.9 }] }));

		expect(outcome?.reduce).toBe("deny");
		expect(outcome?.reason).toContain("outside the declared max");
	});

	it("refuses a band crossing on a layer its governance locked", () => {
		const guard = identityGuard(policy);

		const outcome = guard(call({ effects: [{ field: "character.virtues.patience", to: 0.5 }] }));

		expect(outcome?.reduce).toBe("deny");
		expect(outcome?.rule).toContain("band:");
	});

	it("asks a person about a crossing on a layer its governance reviews", () => {
		const guard = identityGuard(policy);

		const outcome = guard(call({ effects: [{ field: "personality.traits.humour", to: 0.79 }] }));

		expect(outcome?.reduce).toBe("ask");
	});

	it("says nothing about a coordinate that stays inside its band", () => {
		const guard = identityGuard(policy);

		expect(guard(call({ effects: [{ field: "affect.mood.tone", to: 0.01 }] }))).toBeUndefined();
	});

	it("says nothing about a coordinate nobody declared", () => {
		// Not silently fine: simply not this gate's question. Answering confidently
		// about an undeclared thing is worse than declining to.
		const guard = identityGuard(policy);

		expect(guard(call({ effects: [{ field: "made.up", to: 99 }] }))).toBeUndefined();
	});

	it("says nothing when no effect was projected, which is the ordinary case", () => {
		expect(identityGuard(policy)(call())).toBeUndefined();
	});

	it("takes the longest matching prefix, so a layer can be narrowed", () => {
		const narrowed: IdentityPolicy = {
			...policy,
			postures: { ...policy.postures, "character.virtues.patience": "review" },
		};

		expect(postureFor(narrowed, "character.virtues.patience")).toBe("review");
		expect(postureFor(narrowed, "character.virtues.courage")).toBe("locked");
	});

	it("puts a coordinate nobody wrote a posture for in front of a person", () => {
		// A coordinate nobody wrote a posture for is one nobody thought about.
		expect(postureFor({ ...policy, postures: {} }, "anything")).toBe("review");
	});

	it("recognises a crossing from where the coordinate currently is", () => {
		expect(examine(policy, "affect.mood.tone", 0)).toEqual({ kind: "inside" });
		expect(examine(policy, "made.up", 1)).toBeUndefined();
	});
});

describe("the two axes compose without knowing about each other", () => {
	const compiled: CompiledPolicy = {
		persona_version_id: "clio@1.0.0",
		hash: "x",
		compiled_at: new Date().toISOString(),
		ttl_seconds: 3600,
		deny: [],
		allow: [],
		hard_limits: ["never email a customer without approval"],
		prohibited_behaviors: [],
		egress_allowlist: [],
		sandbox: "workspace-write",
		// `on-request` gates every call regardless of what it does, which is the right
		// posture for an untrusted persona and the wrong fixture for showing that the
		// two axes are independent: it would drown the identity axis in asks.
		approval: "never",
		gate_rules: [],
	};

	it("denies when either axis denies", () => {
		const guards = new GuardSet();
		guards.add(capabilityGuard(compile(compiled)));
		guards.add({ name: "identity", check: identityGuard(policy) });

		const refused = guards.decide(
			call({ tool: "read_file", argsText: "README", effects: [{ field: "character.virtues.patience", to: 0.5 }] }),
		);

		expect(refused.verdict).toBe("deny");
		expect(refused.contributions[0]!.guard).toBe("identity");
	});

	it("refuses when there is no policy to consult", () => {
		// "There is no policy" has to be a refusal somebody can see in the list of
		// guards, not a special case buried in the loop.
		const guards = new GuardSet();
		guards.add(requirePolicy(undefined));

		const result = guards.decide(call());

		expect(result.verdict).toBe("deny");
		expect(result.contributions[0]!.rule).toBe("no_policy");
	});

	it("allows when a policy is present and neither axis objects", () => {
		const guards = new GuardSet();
		guards.add(requirePolicy(compile(compiled)));
		guards.add(capabilityGuard(compile(compiled)));
		guards.add({ name: "identity", check: identityGuard(policy) });

		expect(guards.decide(call({ tool: "read_file", argsText: "README" })).verdict).toBe("allow");
	});
});

describe("a guard set is something a component can add to and have cleaned up", () => {
	it("removes a guard when its registration is undone", () => {
		const guards = new GuardSet();
		const remove = guards.add(refuses);

		expect(guards.decide(call()).verdict).toBe("deny");
		remove();
		expect(guards.decide(call()).verdict).toBe("allow");
	});

	it("refuses two guards with one name, because a reason has to say who gave it", () => {
		const guards = new GuardSet();
		guards.add(refuses);

		expect(() => guards.add({ ...refuses })).toThrow(/already registered/);
	});

	it("is idempotent about removal, because teardown races are ordinary", () => {
		const guards = new GuardSet();
		const remove = guards.add(refuses);
		remove();
		remove();

		expect(guards.all()).toHaveLength(0);
	});
});

describe("with no guards at all there is no gate", () => {
	it("allows, and that is the composition's problem rather than this loop's", () => {
		expect(decide([]).verdict).toBe("allow");
	});
});
