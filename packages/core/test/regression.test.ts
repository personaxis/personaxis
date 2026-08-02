// Noticing that a persona got worse, and being right about it.
//
// The two failures are opposites and both end the same way. Too sensitive: a post-mortem
// after every run, a persona learning from noise, and a channel nobody reads by the time the
// real regression arrives. Too blunt: an aggregate that hides the one governance scenario
// that flipped inside a percentage that barely moved.

import { describe, expect, it } from "vitest";

import {
	BEHAVIORAL_FLIP_THRESHOLD,
	compareRuns,
	describeComparison,
	SCORE_DROP_THRESHOLD,
	type ScenarioResult,
	type SuiteRun,
} from "../src/regression.js";

function scenario(id: string, passed: boolean, category: ScenarioResult["category"] = "behavioral", score?: number): ScenarioResult {
	return { id, category, passed, ...(score !== undefined ? { score } : {}) };
}

const run = (label: string, results: ScenarioResult[]): SuiteRun => ({ label, results });

describe("what counts as a regression", () => {
	it("says nothing when nothing changed", () => {
		const same = [scenario("a", true), scenario("b", true)];
		const comparison = compareRuns(run("v1", same), run("v2", same));

		expect(comparison.regressed).toBe(false);
		expect(comparison.verdict).toBe("Nothing regressed.");
	});

	it("does not fire on ONE behavioral flip", () => {
		// A single flip between two runs of a sampled model is the base rate. A report that
		// fires on the base rate is a report nobody finishes reading.
		const comparison = compareRuns(
			run("v1", [scenario("a", true), scenario("b", true)]),
			run("v2", [scenario("a", false), scenario("b", true)]),
		);

		expect(comparison.regressed).toBe(false);
		expect(comparison.regressions).toHaveLength(1);
	});

	it("names the single flip rather than staying silent about it", () => {
		// Somebody reading the run should see it was noticed and judged, not wonder whether
		// the check ran at all.
		const comparison = compareRuns(
			run("v1", [scenario("a", true)]),
			run("v2", [scenario("a", false)]),
		);

		expect(comparison.verdict).toContain("a");
		expect(comparison.verdict).toContain("base rate");
		expect(comparison.verdict).toContain("Two would be");
	});

	it("fires on two", () => {
		const comparison = compareRuns(
			run("v1", [scenario("a", true), scenario("b", true)]),
			run("v2", [scenario("a", false), scenario("b", false)]),
		);

		expect(comparison.regressed).toBe(true);
		expect(BEHAVIORAL_FLIP_THRESHOLD).toBe(2);
	});

	it("fires on ONE governance scenario, at n=1", () => {
		// The whole product is the claim that a limit holds without a witness. A governance
		// scenario going red is not a trend to watch, it is the thing itself.
		const comparison = compareRuns(
			run("v1", [scenario("gate", true, "governance")]),
			run("v2", [scenario("gate", false, "governance")]),
		);

		expect(comparison.regressed).toBe(true);
		expect(comparison.verdict).toContain("no acceptable failure rate");
	});

	it("fires on ONE security scenario too", () => {
		const comparison = compareRuns(
			run("v1", [scenario("egress", true, "security")]),
			run("v2", [scenario("egress", false, "security")]),
		);
		expect(comparison.regressed).toBe(true);
	});

	it("catches a scenario that still passes but by much less", () => {
		// A scenario scraping through is on its way to failing, and the run where it finally
		// does is the one that looks sudden.
		const comparison = compareRuns(
			run("v1", [scenario("a", true, "behavioral", 0.9), scenario("b", true, "behavioral", 0.9)]),
			run("v2", [scenario("a", true, "behavioral", 0.7), scenario("b", true, "behavioral", 0.7)]),
		);

		expect(comparison.regressed).toBe(true);
		expect(comparison.regressions[0].kind).toBe("scored-lower");
	});

	it("ignores a score wobble below the threshold", () => {
		const wobble = SCORE_DROP_THRESHOLD / 2;
		const comparison = compareRuns(
			run("v1", [scenario("a", true, "behavioral", 0.9), scenario("b", true, "behavioral", 0.9)]),
			run("v2", [scenario("a", true, "behavioral", 0.9 - wobble), scenario("b", true, "behavioral", 0.9 - wobble)]),
		);

		expect(comparison.regressions).toEqual([]);
	});
});

describe("what it refuses to call a regression", () => {
	it("a scenario that only exists in one run", () => {
		// A suite that gained a scenario is not a persona that got worse. Counting it is how
		// a report cries wolf on the day somebody adds a test.
		const comparison = compareRuns(
			run("v1", [scenario("a", true)]),
			run("v2", [scenario("a", true), scenario("brand_new", false, "governance")]),
		);

		expect(comparison.regressed).toBe(false);
		expect(comparison.unmatched).toContain("brand_new");
	});

	it("a scenario that was removed", () => {
		const comparison = compareRuns(
			run("v1", [scenario("a", true), scenario("retired", true)]),
			run("v2", [scenario("a", true)]),
		);

		expect(comparison.regressed).toBe(false);
		expect(comparison.unmatched).toContain("retired");
	});

	it("a scenario that was already failing", () => {
		// Still broken is not newly broken. Reporting it every run is how a known failure
		// becomes background noise that hides a new one.
		const comparison = compareRuns(
			run("v1", [scenario("a", false, "governance")]),
			run("v2", [scenario("a", false, "governance")]),
		);
		expect(comparison.regressed).toBe(false);
	});

	it("a scenario that recovered", () => {
		const comparison = compareRuns(
			run("v1", [scenario("a", false)]),
			run("v2", [scenario("a", true)]),
		);

		expect(comparison.regressed).toBe(false);
		expect(comparison.recovered).toEqual(["a"]);
	});
});

describe("the report", () => {
	it("leads with what regressed and why it counted", () => {
		// A report opening with a table of everything that passed buries its own point.
		const before = run("baseline", [scenario("gate", true, "governance"), scenario("b", false)]);
		const after = run("today", [scenario("gate", false, "governance"), scenario("b", true)]);
		const text = describeComparison(before, after, compareRuns(before, after));

		expect(text.split("\n")[0]).toContain("no acceptable failure rate");
		expect(text).toContain("governance: gate passed in baseline and fails in today");
	});

	it("says what recovered, so it is not only bad news", () => {
		const before = run("baseline", [scenario("a", false)]);
		const after = run("today", [scenario("a", true)]);
		expect(describeComparison(before, after, compareRuns(before, after))).toContain("Recovered: a");
	});

	it("says the suite changed rather than counting it", () => {
		const before = run("baseline", [scenario("a", true)]);
		const after = run("today", [scenario("a", true), scenario("new", true)]);
		const text = describeComparison(before, after, compareRuns(before, after));

		expect(text).toContain("not counted either way");
	});

	it("is deterministic, so two people reading the same runs argue about the same thing", () => {
		const before = run("baseline", [scenario("a", true), scenario("b", true)]);
		const after = run("today", [scenario("a", false), scenario("b", false)]);

		expect(describeComparison(before, after, compareRuns(before, after))).toBe(
			describeComparison(before, after, compareRuns(before, after)),
		);
	});
});
