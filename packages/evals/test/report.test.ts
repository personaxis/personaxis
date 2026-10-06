/**
 * The three ways the eval report is printed: JSON for machines, Markdown for the CI
 * artifact, and the terminal view. The runner was tested and these were not, so the
 * package never reached its own coverage floor.
 */

import { describe, expect, it } from "vitest";

import { toConsole, toJSON, toMarkdown } from "../src/report.js";
import { runScenarios } from "../src/runner.js";
import type { EvalReport, Scenario } from "../src/types.js";

/** Two scenarios, one passing and one failing, so both branches of every line render. */
const scenarios: Scenario[] = [
	{
		id: "clamp-holds",
		category: "state",
		conformanceClass: "C1",
		description: "a write outside the range is clamped",
		async run() {
			return {
				id: "clamp-holds",
				category: "state",
				conformanceClass: "C1",
				description: "a write outside the range is clamped",
				passed: true,
				score: 1,
				checks: [{ name: "clamped", pass: true, detail: "0.9 became 0.8" }],
			};
		},
	},
	{
		id: "budget-stops",
		category: "runtime",
		conformanceClass: "C2",
		description: "a turn stops at its budget",
		async run() {
			return {
				id: "budget-stops",
				category: "runtime",
				conformanceClass: "C2",
				description: "a turn stops at its budget",
				passed: false,
				score: 0,
				checks: [{ name: "stopped", pass: false, detail: "ran 12 steps of 10" }],
			};
		},
	},
];

async function report(): Promise<EvalReport> {
	return runScenarios(scenarios);
}

describe("the eval report", () => {
	it("round-trips through JSON", async () => {
		const r = await report();
		expect(JSON.parse(toJSON(r))).toEqual(JSON.parse(JSON.stringify(r)));
	});

	it("renders Markdown with the totals, the classes and every scenario", async () => {
		const md = toMarkdown(await report());
		expect(md).toContain("1/2 scenarios passed");
		expect(md).toContain("| `clamp-holds` | PASS |");
		expect(md).toContain("| `budget-stops` | FAIL |");
		expect(md).toContain("✗ stopped");
	});

	it("shows the failing check and its detail in the terminal view", async () => {
		const out = toConsole(await report());
		expect(out).toContain("1/2 passed");
		expect(out).toContain("budget-stops");
		expect(out).toContain("ran 12 steps of 10");
		expect(out).not.toContain("0.9 became 0.8");
	});
});
