/**
 * What a sub-persona inherits, and what it cannot ask for.
 *
 * The reference wrote this decision twice: once inheriting the parent's approval
 * posture, and once reversing that. It shipped the first version, and what it produced
 * was children blocked on a question no surface displayed, so a permission-blocked
 * child looked exactly like a working one. These are the tests for the second version.
 */

import { describe, expect, it } from "vitest";

import {
	Ledger,
	deepen,
	delegate,
	delegationAuthor,
	ledgerForChild,
	scopeStatement,
} from "../src/run/index.js";

const at = () => new Date(Date.UTC(2026, 7, 23, 9, 0, 0));

describe("the scope is photographed at the moment of delegating", () => {
	it("copies what the parent explicitly narrowed", () => {
		const result = delegate({
			parentDepth: 0,
			parentScope: { directories: ["/work/repo"], sandbox: "read-only" },
			now: at,
		});

		expect(result.ok && result.scope.inherited).toEqual({
			directories: ["/work/repo"],
			sandbox: "read-only",
		});
	});

	it("hands down nothing when the parent narrowed nothing", () => {
		// Defaults belong to the operator and can change. Freezing today's default into
		// every child ever delegated would make an operator's later change invisible.
		const result = delegate({ parentDepth: 0, parentScope: {}, now: at });

		expect(result.ok && result.scope.inherited).toEqual({});
	});

	it("does not change when the parent widens afterwards", () => {
		// The reason live resolution was rejected: a parent that widens mid-run would
		// retroactively widen a child that is already running.
		const parentScope = { directories: ["/work/repo"] };
		const result = delegate({ parentDepth: 0, parentScope, now: at });
		const snapshot = result.ok ? result.scope.inherited.directories : undefined;

		parentScope.directories.push("/work/everything-else");

		expect(snapshot).toEqual(["/work/repo"]);
	});

	it("says when the photograph was taken, so the record can say what it was of", () => {
		const result = delegate({ parentDepth: 0, parentScope: {}, now: at });

		expect(result.ok && result.scope.at).toBe("2026-08-23T09:00:00.000Z");
	});
});

describe("a delegated child does not ask", () => {
	it("is never allowed to queue a question", () => {
		// The state the reference shipped and had to escape: a child waiting on somebody
		// who is not there, indistinguishable from a child working.
		const result = delegate({ parentDepth: 0, parentScope: {}, now: at });

		expect(result.ok && result.scope.asks).toBe(false);
	});

	it("is told its scope is fixed and that it reports rather than retries", () => {
		const result = delegate({ parentDepth: 0, parentScope: { directories: ["/a"] }, now: at });
		const statement = result.ok ? scopeStatement(result.scope) : "";

		expect(statement).toContain("cannot be widened");
		expect(statement).toContain("refused automatically");
		expect(statement).toContain("not with retries");
		expect(statement).toContain("/a");
	});
});

describe("depth only ever goes up", () => {
	it("counts one deeper than its parent", () => {
		const result = delegate({ parentDepth: 2, parentScope: {}, now: at });

		expect(result.ok && result.scope.depth).toBe(3);
	});

	it("refuses past the declared limit, and says which limit", () => {
		const result = delegate({ parentDepth: 3, parentScope: {}, maxDepth: 3, now: at });

		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("declared limit of 3");
	});

	it("cannot be lowered by a resume", () => {
        // Otherwise a resume launders a grandchild into a root.
		expect(deepen(4, 0)).toBe(4);
		expect(deepen(4, 7)).toBe(7);
	});
});

describe("a child spends from the same ceiling", () => {
	it("shares the parent's ledger rather than getting its own", () => {
		const parent = new Ledger({ steps: 2 });
		const child = ledgerForChild(parent);

		child.chargeStep();
		child.chargeStep();

		expect(parent.room().ok).toBe(false);
	});
});

describe("the record says who took the photograph", () => {
	it("attributes it to the delegation, naming the parent", () => {
		expect(delegationAuthor("clio")).toMatchObject({
			kind: "runtime",
			mechanism: "delegation",
		});
		expect(delegationAuthor("clio").kind === "runtime" && delegationAuthor("clio").reason).toContain(
			"clio",
		);
	});
});
