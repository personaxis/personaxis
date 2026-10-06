/**
 * A policy the gate will evaluate against is one that came out of `compile()`.
 *
 * E30, and it was found by an instrument rather than by review. While measuring `E28` I
 * built an `ExecutablePolicy` by hand with `persona_id` where `persona_version_id`
 * belongs and no `ttl_seconds`. Nothing said the policy was wrong. A guard threw
 * `Cannot read properties of undefined (reading 'length')`, the cascade contained it by
 * denying, and the turn ended with the persona saying "I'm sorry, I can't access the
 * repository". From outside, that is a model that will not work. It took twenty minutes
 * to tell the two apart, and the whole lesson is in that: a broken instrument imitates
 * the subject it came to measure.
 *
 * Two doors were open and both are shut by the same key.
 *
 * BY HAND. The type was structural, so anything with the right fields was one. It is
 * branded now with a symbol this module does not export, so a hand-built object is not
 * of the type and the compiler says so at the call site rather than the cascade saying
 * something else in production.
 *
 * OFF A WIRE. `ExecutablePolicy` holds `RegExp[]` and a `Map`, and neither survives
 * JSON. A deserialised policy used to have the right shape for TypeScript and explode on
 * every call. It is not of the type either now, which is the honest answer: what came
 * back from the wire is a `CompiledPolicy`, and turning one of those into an executable
 * policy is what `compile` is for.
 *
 * And a policy that is malformed IN ITS DATA is refused at the door with everything
 * wrong with it named, because `compile` used to take whatever it was handed.
 */

import { describe, expect, it } from "vitest";

import { compile, evaluate, type CompiledPolicy } from "../src/enforcement/policy-compile.js";

function policy(over: Partial<CompiledPolicy> = {}): CompiledPolicy {
	return {
		persona_version_id: "pv_test",
		hash: "h",
		compiled_at: new Date().toISOString(),
		ttl_seconds: 3600,
		deny: [],
		allow: [],
		hard_limits: [],
		prohibited_behaviors: [],
		egress_allowlist: [],
		sandbox: "read-only",
		approval: "never",
		gate_rules: [],
		...over,
	};
}

describe("what may be evaluated against", () => {
	it("compiles a whole policy and evaluates against it", () => {
		const executable = compile(policy({ deny: ["rm -rf"] }));

		expect(
			evaluate(executable, { tool: "shell", args_text: "rm -rf /", action_classes: [] }),
		).toMatchObject({ verdict: "deny" });
	});

	it("cannot be built by hand, which is the whole point", () => {
		// The exact shape of the E28 incident: every field looks right and the brand is
		// not there. This one is DANGEROUS rather than broken, and that is why the type
		// has to be the guard: with empty lists it evaluates perfectly well, so nothing
		// at runtime would ever have told anybody. The assertion is the
		// `@ts-expect-error`, which fails the file the day it stops being an error, and
		// the call is never made because making it would prove the opposite.
		const byHand = {
			policy: policy(),
			deny: [],
			allow: [],
			hardLimitKeywords: [],
			prohibitedKeywords: [],
			gatesByClass: new Map(),
		};

		const neverCalled = (): unknown =>
			// @ts-expect-error an object that did not come out of compile() is not one
			evaluate(byHand, { tool: "shell", args_text: "ls", action_classes: [] });

		expect(typeof neverCalled).toBe("function");
	});

	it("cannot come back off a wire, because half of it does not serialise", () => {
		// `RegExp[]` and a `Map` do not survive JSON: the regexes come back as `{}` and so
		// does the map. Before the brand this had the right shape for TypeScript and threw
		// on every call, which is the same disguise as the hand-built one.
		//
		// A CORRECTION, and the type checker is what made it: the first version of this
		// asserted `@ts-expect-error` on the raw `JSON.parse` result, and the directive
		// came back unused. `JSON.parse` returns `any`, and `any` defeats every brand
		// there has ever been. So what the brand actually buys on this path is narrower
		// than I first wrote: it does not stop `any`, it stops the parsed value once
		// somebody types it, which is the only form in which a careful caller handles one.
		const parsed = JSON.parse(
			JSON.stringify(compile(policy({ deny: ["rm -rf"] }))),
		) as Record<string, unknown>;

		expect(parsed["deny"]).toEqual([{}]);
		expect(parsed["gatesByClass"]).toEqual({});

		const neverCalled = (): unknown =>
			// @ts-expect-error what came back from the wire is not an executable policy
			evaluate(parsed, { tool: "shell", args_text: "ls", action_classes: [] });
		expect(typeof neverCalled).toBe("function");

		// And what forcing it past the type gets you, which is the failure this replaces:
		// not a refusal anybody can read, a throw from inside the cascade.
		expect(() =>
			evaluate(parsed as never, { tool: "shell", args_text: "ls", action_classes: [] }),
		).toThrow(/is not a function/);
	});

	it("survives being passed around, so the brand is not in the way", () => {
		// The mirror image, and worth asserting: a brand that made an ordinary hand-off
		// awkward would be paid for on every call site.
		const executable = compile(policy({ deny: ["secrets"] }));
		const held = { capability: executable };

		expect(
			evaluate(held.capability, { tool: "read", args_text: "secrets.env", action_classes: [] }),
		).toMatchObject({ verdict: "deny" });
	});
});

describe("a policy that is malformed in its data", () => {
	it("is refused at the door rather than inside a guard", () => {
		// The failure this replaces did not look like a bad policy. It looked like a
		// persona that would not work.
		expect(() => compile(policy({ deny: undefined as never }))).toThrow(
			/deny must be an array/,
		);
	});

	it("names everything wrong with it at once", () => {
		// A shape somebody is building by hand is usually wrong in more than one place,
		// and revealing one fault per attempt teaches people the API is hostile rather
		// than that they are close.
		let message = "";
		try {
			compile({ persona_version_id: "pv" } as never);
		} catch (thrown) {
			message = (thrown as Error).message;
		}

		for (const missing of [
			"deny",
			"allow",
			"hard_limits",
			"prohibited_behaviors",
			"egress_allowlist",
			"gate_rules",
			"hash",
			"compiled_at",
			"sandbox",
			"approval",
			"ttl_seconds",
		]) {
			expect(message).toContain(missing);
		}
		expect(message).not.toContain("persona_version_id must");
	});

	it("checks what the evaluator dereferences, not merely what is declared", () => {
		// `ttl_seconds` as a string passes a shallow "is it there" check and is still
		// the wrong kind. The list is drawn from what gets read, because a missing field
		// nothing reads is tidiness and a missing one something reads is a thrown guard.
		expect(() => compile(policy({ ttl_seconds: "3600" as never }))).toThrow(
			/ttl_seconds must be a number/,
		);
	});

	it("refuses an empty object rather than compiling a policy that permits reasoning", () => {
		expect(() => compile({} as never)).toThrow(/cannot be compiled/);
	});
});
