/**
 * Two runs of the suite, and whether anything got worse.
 *
 * The comparison has lived in the engine since phase 4 with no caller, so a governance
 * scenario could go red across a model change and the only evidence was two pass rates
 * in two terminals that nobody diffed. Both runs looked like a number somebody glanced
 * at, and "still 94%" reads the same whether or not the clamp stopped holding.
 *
 * The severity rule is the interesting part and it is not symmetric. A behavioural
 * scenario flipping between two runs of a sampled model is the base rate; a governance
 * or security one going red is the product's claim failing. A gate that treated them
 * alike would fire on noise and be switched off within a week, which is how a suite
 * stops being read.
 */

import { describe, expect, it } from "vitest";

import { asSuiteRun, compareReports } from "../src/compare.js";
import type { EvalReport, ScenarioResult } from "../src/types.js";

function scenario(over: Partial<ScenarioResult> = {}): ScenarioResult {
	return {
		id: "s1",
		category: "behavioral",
		conformanceClass: "C1",
		description: "a scenario",
		passed: true,
		score: 1,
		checks: [],
		...over,
	};
}

function report(results: ScenarioResult[]): EvalReport {
	return {
		total: results.length,
		passed: results.filter((r) => r.passed).length,
		failed: results.filter((r) => !r.passed).length,
		passRate: results.length ? results.filter((r) => r.passed).length / results.length : 1,
		byCategory: {},
		byClass: {
			C0: { passed: 0, total: 0, met: true },
			C1: { passed: 0, total: 0, met: true },
			C2: { passed: 0, total: 0, met: true },
		},
		metrics: {},
		results,
	};
}

const labels = { baseline: "yesterday", current: "today" };

describe("what counts as a regression", () => {
	it("blocks on a single governance scenario going red", () => {
		// No acceptable failure rate. The whole product is the claim that a limit holds
		// without a witness, so this is the thing itself rather than a trend to watch.
		const before = report([scenario({ id: "clamp", category: "governance" })]);
		const after = report([scenario({ id: "clamp", category: "governance", passed: false })]);

		const outcome = compareReports(before, after, labels);
		expect(outcome.blocking).toBe(true);
		expect(outcome.text).toContain("clamp");
	});

	it("does not block on a single behavioural flip", () => {
		// The base rate of a sampled model. A report that fires on the base rate is a
		// report nobody finishes reading.
		const before = report([scenario({ id: "tone" })]);
		const after = report([scenario({ id: "tone", passed: false })]);

		expect(compareReports(before, after, labels).blocking).toBe(false);
	});

	it("blocks on two behavioural flips, which is past what sampling explains", () => {
		const before = report([scenario({ id: "a" }), scenario({ id: "b" })]);
		const after = report([
			scenario({ id: "a", passed: false }),
			scenario({ id: "b", passed: false }),
		]);

		expect(compareReports(before, after, labels).blocking).toBe(true);
	});

	it("does not block when nothing changed", () => {
		// The control. A comparison that blocked on identical runs would be a gate that
		// never lets anything through, which is the same as no gate.
		const runs = report([scenario({ id: "a", category: "governance" })]);

		expect(compareReports(runs, runs, labels).blocking).toBe(false);
	});

	it("does not block on a scenario that only exists in one run", () => {
		// A suite that gained a scenario is not a persona that got worse, and treating
		// it as one is how a report cries wolf on the day somebody adds a test.
		const before = report([scenario({ id: "a", category: "governance" })]);
		const after = report([
			scenario({ id: "a", category: "governance" }),
			scenario({ id: "new", category: "governance", passed: false }),
		]);

		expect(compareReports(before, after, labels).blocking).toBe(false);
	});
});

describe("mapping a report onto the comparison", () => {
	it("treats a category nobody classified as zero tolerance", () => {
		// The safe reading of an unconsidered case is the strict one. Folding an unknown
		// category into `behavioral` would make a new scenario silently the least
		// important thing in the suite on the day it is added.
		const run = asSuiteRun(report([scenario({ id: "x", category: "brand-new-thing" })]), "r");

		expect(run.results[0]?.category).toBe("governance");
	});

	it("keeps a category the comparison knows", () => {
		const run = asSuiteRun(report([scenario({ id: "x", category: "spec-fidelity" })]), "r");

		expect(run.results[0]?.category).toBe("spec-fidelity");
	});

	it("carries the score, so a scenario scraping through is visible", () => {
		// A scenario passing by less than it used to is on its way to failing, and the
		// run where it finally does is the one that looks sudden.
		const before = report([scenario({ id: "a", score: 1 })]);
		const after = report([scenario({ id: "a", score: 0.5 })]);

		expect(compareReports(before, after, labels).text).toContain("0.50");
	});

	it("carries the labels, so a reader knows which run is which", () => {
		const runs = report([scenario({ id: "a" })]);
		const text = compareReports(runs, runs, labels).text;

		expect(text).toContain("yesterday");
		expect(text).toContain("today");
	});
});
