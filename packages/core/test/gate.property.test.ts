/**
 * The gate's properties, over generated guards and generated orderings.
 *
 * The claim being protected is the one the whole product rests on: **no arrangement of
 * guards produces a permission**. The type already makes the negation unwritable, so
 * what these add is the other half, that the fold over whatever guards exist behaves
 * like a meet: order-independent, idempotent, and monotone downward.
 *
 * Those three together are what "reorderable" means. Not that you may shuffle the
 * cascade and hope, but that shuffling it provably cannot change the verdict.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	ask,
	deny,
	freezeCall,
	identityGuard,
	meet,
	permitsAtLeast,
	runGuards,
	type Guard,
	type IdentityPolicy,
	type Verdict,
} from "../src/gate/index.js";
import type { Envelope } from "../src/envelopes.js";

const envelope = (mean: number, min: number, max: number): Envelope =>
	({ mean, min, max, range: Math.max(max - mean, mean - min) }) as Envelope;

/** Guards that say one of the three things a guard can say. */
const guards = fc
	.array(
		fc.tuple(
			fc.constantFrom("silent" as const, "ask" as const, "deny" as const),
			fc.integer({ min: 0, max: 999 }),
		),
		{ minLength: 1, maxLength: 8 },
	)
	.map((specs) =>
		specs.map(([kind, id], index): Guard => {
			const name = `g${index}_${id}`;
			return {
				name,
				check: () =>
					kind === "silent"
						? undefined
						: kind === "deny"
							? deny(name, "generated")
							: ask(name, "generated"),
			};
		}),
	);

const call = () => freezeCall({ tool: "t", argsText: "a", turn: "turn", callId: "fixed" });

/** A deterministic shuffle driven by a generated seed. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
	return items
		.map((item, index) => ({ item, weight: Math.sin(seed * 1e6 + index * 7.31) }))
		.sort((left, right) => left.weight - right.weight)
		.map((entry) => entry.item);
}

const verdicts = fc.constantFrom<Verdict>("allow", "ask", "deny");

describe("the verdict is a meet, so ordering cannot change it", () => {
	it("gives the same verdict under any ordering of the same guards", () => {
		fc.assert(
			fc.property(guards, fc.double({ min: 0, max: 1, noNaN: true }), (list, seed) => {
				const straight = runGuards(list, call()).verdict;
				const jumbled = runGuards(shuffled(list, seed), call()).verdict;

				expect(jumbled).toBe(straight);
			}),
			{ numRuns: 400 },
		);
	});

	it("reports the same set of reasons under any ordering, only in a different order", () => {
		fc.assert(
			fc.property(guards, fc.double({ min: 0, max: 1, noNaN: true }), (list, seed) => {
				const straight = runGuards(list, call()).contributions.map((c) => c.guard).sort();
				const jumbled = runGuards(shuffled(list, seed), call())
					.contributions.map((c) => c.guard)
					.sort();

				expect(jumbled).toEqual(straight);
			}),
			{ numRuns: 400 },
		);
	});

	it("never allows once any guard has objected", () => {
		fc.assert(
			fc.property(guards, (list) => {
				const objected = list.some((guard) => guard.check(call()) !== undefined);
				const verdict = runGuards(list, call()).verdict;

				if (objected) expect(verdict).not.toBe("allow");
				else expect(verdict).toBe("allow");
			}),
			{ numRuns: 400 },
		);
	});

	it("cannot be raised by adding a guard", () => {
		// The monotone half. Whatever a new guard says, the answer only ever goes down.
		fc.assert(
			fc.property(guards, guards, (base, extra) => {
				const before = runGuards(base, call()).verdict;
				const after = runGuards([...base, ...extra], call()).verdict;

				expect(permitsAtLeast(before, after)).toBe(true);
			}),
			{ numRuns: 400 },
		);
	});

	it("is unchanged by running the same guard set twice over", () => {
		// Idempotence, which is what makes a re-evaluation on retry safe: judging the
		// same call again must not drift the answer.
		fc.assert(
			fc.property(guards, (list) => {
				const once = runGuards(list, call()).verdict;
				const twice = runGuards([...list, ...list].map((guard, index) => ({
					name: `${guard.name}#${index}`,
					check: guard.check,
				})), call()).verdict;

				expect(twice).toBe(once);
			}),
			{ numRuns: 400 },
		);
	});
});

describe("the meet is a meet", () => {
	it("is commutative", () => {
		fc.assert(
			fc.property(verdicts, verdicts, (left, right) => {
				expect(meet(left, right)).toBe(meet(right, left));
			}),
			{ numRuns: 200 },
		);
	});

	it("is associative", () => {
		fc.assert(
			fc.property(verdicts, verdicts, verdicts, (a, b, c) => {
				expect(meet(meet(a, b), c)).toBe(meet(a, meet(b, c)));
			}),
			{ numRuns: 200 },
		);
	});

	it("has allow as its identity, which is why an empty gate allows", () => {
		fc.assert(
			fc.property(verdicts, (v) => {
				expect(meet("allow", v)).toBe(v);
			}),
			{ numRuns: 200 },
		);
	});

	it("never returns something more permissive than either input", () => {
		fc.assert(
			fc.property(verdicts, verdicts, (left, right) => {
				const result = meet(left, right);
				expect(permitsAtLeast(left, result)).toBe(true);
				expect(permitsAtLeast(right, result)).toBe(true);
			}),
			{ numRuns: 200 },
		);
	});
});

describe("the identity axis never permits what the envelope forbids", () => {
	const policy: IdentityPolicy = {
		envelopes: { x: envelope(0.5, 0.2, 0.8) },
		current: { x: 0.5 },
		postures: { x: "autonomous" },
	};

	it("refuses every value outside the declared range, whatever the posture", () => {
		// Leaving the envelope is not drift, it is a different persona, so the most
		// permissive posture there is must not rescue it.
		fc.assert(
			fc.property(fc.double({ min: -10, max: 10, noNaN: true }), (to) => {
				const outcome = identityGuard(policy)(
					freezeCall({ tool: "t", argsText: "a", turn: "x", effects: [{ field: "x", to }] }),
				);
				const outside = to < 0.2 || to > 0.8;

				if (outside) expect(outcome?.reduce).toBe("deny");
			}),
			{ numRuns: 400 },
		);
	});

	it("says nothing about any coordinate that was never declared", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1 }).filter((field) => field !== "x"),
				fc.double({ min: -10, max: 10, noNaN: true }),
				(field, to) => {
					const outcome = identityGuard(policy)(
						freezeCall({ tool: "t", argsText: "a", turn: "x", effects: [{ field, to }] }),
					);

					expect(outcome).toBeUndefined();
				},
			),
			{ numRuns: 300 },
		);
	});
});
