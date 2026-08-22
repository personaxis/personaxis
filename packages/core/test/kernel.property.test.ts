/**
 * The kernel's properties, checked over random orders rather than chosen ones.
 *
 * An example test proves a case somebody thought of. The whole claim of a declared
 * dependency graph is that **no order matters**, and the orders a person picks are
 * the ones they already believed worked. So these run over generated orders,
 * generated permission grants and generated teardown sequences, and the thing they
 * are protecting is the one sentence the kernel sells: mounting and unmounting N
 * components in any order leaves the context exactly as it was.
 *
 * Each property below is a promise from a header somewhere in `src/kernel/`. If one
 * of these goes red, the header it names is now a lie.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	GRANTED,
	Kernel,
	PERMISSIONS,
	denied,
	permissionKey,
	serviceKey,
	type Component,
	type PermissionSource,
	type ServiceKey,
} from "../src/kernel/index.js";

/** A small, fixed pool so generated graphs actually overlap and contend. */
const KEYS: ServiceKey<number>[] = ["a", "b", "c", "d", "e"].map((id) => serviceKey<number>(id));
const PERMS = ["p", "q", "r"].map((id) => permissionKey(id));

interface Spec {
	readonly name: string;
	/** Indices into KEYS. */
	readonly needs: readonly number[];
	/** Indices into PERMS. */
	readonly requires: readonly number[];
	/** Index into KEYS of what it provides while active, or -1 for nothing. */
	readonly provides: number;
}

/**
 * Generates a set of components that can depend on each other.
 *
 * `provides` is what makes the graph real rather than a flat list: a component that
 * provides a key while it is active is the case where mounting order could plausibly
 * matter, and it is the case that breaks a kernel that resolves once at mount.
 */
const specs = fc
	.uniqueArray(
		fc.record({
			name: fc.constant(""),
			needs: fc.uniqueArray(fc.integer({ min: 0, max: KEYS.length - 1 }), { maxLength: 3 }),
			requires: fc.uniqueArray(fc.integer({ min: 0, max: PERMS.length - 1 }), { maxLength: 2 }),
			provides: fc.integer({ min: -1, max: KEYS.length - 1 }),
		}),
		{ minLength: 1, maxLength: 6, selector: (spec) => JSON.stringify(spec) },
	)
	.map((raw) =>
		raw.map((spec, index): Spec => ({ ...spec, name: `c${index}` })),
	)
	// A component that provides one of the keys it needs is a cycle of one, which the
	// kernel is entitled to refuse. These properties are about acyclic graphs.
	.map((raw) => raw.filter((spec) => !spec.needs.includes(spec.provides)))
	.filter((raw) => raw.length > 0)
	// Two components providing the same key is a duplicate registration, which is a
	// loud failure by design and has its own example test.
	.filter((raw) => {
		const provided = raw.map((spec) => spec.provides).filter((index) => index >= 0);
		return new Set(provided).size === provided.length;
	});

function build(kernel: Kernel, spec: Spec, log: string[]): Component {
	return {
		name: spec.name,
		needs: spec.needs.map((index) => KEYS[index]!),
		requires: spec.requires.map((index) => PERMS[index]!),
		activate: (ctx) => {
			log.push(`+${spec.name}`);
			if (spec.provides >= 0) {
				ctx.scope.use(kernel.provide(KEYS[spec.provides]!, spec.provides));
			}
			ctx.scope.use(() => log.push(`-${spec.name}`));
		},
	};
}

function sourceOf(granted: ReadonlySet<string>): PermissionSource {
	return {
		answer: (permission) =>
			granted.has(permission.id) ? GRANTED : denied(`${permission.id} is not granted`),
	};
}

/** Runs one scenario and returns which components ended up active. */
function activeAfter(
	order: readonly number[],
	list: readonly Spec[],
	granted: ReadonlySet<string>,
	log: string[],
): Set<string> {
	const kernel = new Kernel();
	kernel.provide(PERMISSIONS, sourceOf(granted));
	for (const index of order) kernel.mount(build(kernel, list[index]!, log));
	return new Set(list.filter((spec) => kernel.stateOf(spec.name) === "active").map((s) => s.name));
}

/** A permutation of 0..n-1, so a scenario can be replayed in any order. */
const permutationOf = (n: number) =>
	fc
		.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: n, maxLength: n })
		.map((weights) =>
			weights
				.map((weight, index) => ({ weight, index }))
				.sort((left, right) => left.weight - right.weight)
				.map((entry) => entry.index),
		);

describe("mounting order does not change the outcome", () => {
	it("reaches the same set of active components whatever order they mount in", () => {
		fc.assert(
			fc.property(
				specs,
				fc.subarray(PERMS.map((permission) => permission.id)),
				fc.double({ min: 0, max: 1, noNaN: true }),
				(list, grantedIds, seed) => {
					const granted = new Set(grantedIds);
					const forward = list.map((_, index) => index);
					const shuffled = [...forward].sort(
						(left, right) => Math.sin(seed * 1e6 + left) - Math.sin(seed * 1e6 + right),
					);

					const first = activeAfter(forward, list, granted, []);
					const second = activeAfter(shuffled, list, granted, []);

					expect([...second].sort()).toEqual([...first].sort());
				},
			),
			{ numRuns: 300 },
		);
	});
});

describe("unmounting leaves the context exactly as it was", () => {
	it("undoes every activation, in any teardown order", () => {
		fc.assert(
			fc.property(specs, fc.subarray(PERMS.map((p) => p.id)), (list, grantedIds) => {
				const granted = new Set(grantedIds);
				const log: string[] = [];
				const kernel = new Kernel();
				kernel.provide(PERMISSIONS, sourceOf(granted));

				const unmounts = list.map((spec) => kernel.mount(build(kernel, spec, log)));
				for (const unmount of unmounts) unmount();

				// Every `+name` has a matching `-name`. Anything left is a component that
				// activated and was never torn down, which is the leak the whole effect
				// scope exists to prevent.
				const balance = new Map<string, number>();
				for (const entry of log) {
					const name = entry.slice(1);
					balance.set(name, (balance.get(name) ?? 0) + (entry[0] === "+" ? 1 : -1));
				}
				for (const [, count] of balance) expect(count).toBe(0);
			}),
			{ numRuns: 300 },
		);
	});

	it("leaves no component active and no key provided after shutdown", () => {
		fc.assert(
			fc.property(specs, fc.subarray(PERMS.map((p) => p.id)), (list, grantedIds) => {
				const kernel = new Kernel();
				kernel.provide(PERMISSIONS, sourceOf(new Set(grantedIds)));
				for (const spec of list) kernel.mount(build(kernel, spec, []));

				kernel.shutdown();

				for (const spec of list) expect(kernel.stateOf(spec.name)).toBeUndefined();
				for (const key of KEYS) expect(kernel.peek(key)).toBeUndefined();
			}),
			{ numRuns: 300 },
		);
	});

	it("unmounting in a random order still balances", () => {
		fc.assert(
			fc.property(
				specs.chain((list) =>
					fc.tuple(fc.constant(list), permutationOf(list.length)),
				),
				fc.subarray(PERMS.map((p) => p.id)),
				([list, order], grantedIds) => {
					const log: string[] = [];
					const kernel = new Kernel();
					kernel.provide(PERMISSIONS, sourceOf(new Set(grantedIds)));
					const unmounts = list.map((spec) => kernel.mount(build(kernel, spec, log)));

					for (const index of order) unmounts[index]!();

					const balance = new Map<string, number>();
					for (const entry of log) {
						const name = entry.slice(1);
						balance.set(name, (balance.get(name) ?? 0) + (entry[0] === "+" ? 1 : -1));
					}
					for (const [, count] of balance) expect(count).toBe(0);
				},
			),
			{ numRuns: 300 },
		);
	});
});

describe("a permission behaves exactly like a service", () => {
	it("withdrawing one suspends its dependents and leaves everything else alone", () => {
		fc.assert(
			fc.property(specs, fc.integer({ min: 0, max: PERMS.length - 1 }), (list, victim) => {
				const all = new Set(PERMS.map((permission) => permission.id));
				const kernel = new Kernel();
				kernel.provide(PERMISSIONS, sourceOf(all));
				for (const spec of list) kernel.mount(build(kernel, spec, []));

				const before = new Map(
					list.map((spec) => [spec.name, kernel.stateOf(spec.name)] as const),
				);

				const narrowed = new Set(all);
				narrowed.delete(PERMS[victim]!.id);
				kernel.replace(PERMISSIONS, sourceOf(narrowed));

				for (const spec of list) {
					const dependsOnVictim = spec.requires.includes(victim);
					const after = kernel.stateOf(spec.name);
					if (dependsOnVictim) {
						// It cannot still be active on a permission that was taken away.
						expect(after).not.toBe("active");
					} else if (before.get(spec.name) === "active") {
						// Everything else keeps running. This is the half that makes hot
						// withdrawal usable: no restart, no collateral suspension, except
						// where a suspended component was the one providing a key.
						const providerLost = list.some(
							(other) =>
								other.requires.includes(victim) &&
								other.provides >= 0 &&
								spec.needs.includes(other.provides),
						);
						if (!providerLost) expect(after).toBe("active");
					}
				}
			}),
			{ numRuns: 300 },
		);
	});

	it("re-granting a withdrawn permission brings its dependents back", () => {
		fc.assert(
			fc.property(specs, fc.integer({ min: 0, max: PERMS.length - 1 }), (list, victim) => {
				const all = new Set(PERMS.map((permission) => permission.id));
				const kernel = new Kernel();
				kernel.provide(PERMISSIONS, sourceOf(all));
				for (const spec of list) kernel.mount(build(kernel, spec, []));
				const before = list.map((spec) => kernel.stateOf(spec.name));

				const narrowed = new Set(all);
				narrowed.delete(PERMS[victim]!.id);
				kernel.replace(PERMISSIONS, sourceOf(narrowed));
				kernel.replace(PERMISSIONS, sourceOf(all));

				expect(list.map((spec) => kernel.stateOf(spec.name))).toEqual(before);
			}),
			{ numRuns: 300 },
		);
	});
});

describe("the epoch only changes when something it names changes", () => {
	it("is stable across a settle that touched nothing it depends on", () => {
		fc.assert(
			fc.property(specs, (list) => {
				const kernel = new Kernel();
				kernel.provide(PERMISSIONS, sourceOf(new Set(PERMS.map((p) => p.id))));
				for (const spec of list) kernel.mount(build(kernel, spec, []));
				const before = list.map((spec) => kernel.epochOf(spec.name));

				// A key nothing in the pool declares. Providing it is a settle that must
				// leave every epoch alone, which is what stops unrelated churn from
				// reloading the world.
				kernel.provide(serviceKey<number>("unrelated"), 1);

				expect(list.map((spec) => kernel.epochOf(spec.name))).toEqual(before);
			}),
			{ numRuns: 300 },
		);
	});
});
