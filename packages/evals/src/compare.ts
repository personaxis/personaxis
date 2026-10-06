/**
 * Two runs of the same suite, and what changed between them.
 *
 * `regression.ts` in the engine has held the comparison since phase 4: which scenarios
 * flipped, which scores dropped, and the rule that a governance or security scenario
 * going red is not a trend to watch but the thing itself. It had no caller, so the
 * suite could go from green to red across a model change and the only evidence was two
 * numbers in two terminals that nobody diffed.
 *
 * This is the caller. The suite already writes a JSON report, so a comparison needs
 * nothing new on disk: yesterday's report is the baseline.
 *
 * ## Why the mapping is a file rather than a cast
 *
 * The report's `category` is a free string and the comparison's is a closed set with a
 * severity attached to each member. Anything not in that set is a category nobody
 * classified, which means nobody decided how seriously to take it, and the safe reading
 * of an unconsidered case is the strict one. So an unknown category is compared as
 * `governance`: zero tolerance. The alternative, folding it into `behavioral`, would
 * make a new scenario silently the least important thing in the suite on the day it is
 * added, which is exactly backwards.
 */

import { compareRuns, describeComparison, type ScenarioCategory, type SuiteRun } from "@personaxis/core";

import type { EvalReport } from "./types.js";

const KNOWN: ReadonlySet<string> = new Set([
	"governance",
	"security",
	"spec-fidelity",
	"behavioral",
]);

/** A report as the comparison sees it. */
export function asSuiteRun(report: EvalReport, label: string): SuiteRun {
	return {
		label,
		results: report.results.map((result) => ({
			id: result.id,
			category: (KNOWN.has(result.category) ? result.category : "governance") as ScenarioCategory,
			passed: result.passed,
			score: result.score,
		})),
	};
}

/** What a comparison decided, and whether it should stop a pipeline. */
export interface CompareOutcome {
	readonly text: string;
	/**
	 * The comparison's own verdict, not a second opinion about it.
	 *
	 * `compareRuns` already holds the rule: a governance or security scenario going red
	 * counts on its own, and a behavioural one needs a second before sampling stops
	 * explaining it. Recomputing that here would be the same rule with two definitions,
	 * and they would drift the day somebody adjusts one.
	 */
	readonly blocking: boolean;
}

export function compareReports(
	baseline: EvalReport,
	current: EvalReport,
	labels: { readonly baseline: string; readonly current: string },
): CompareOutcome {
	const before = asSuiteRun(baseline, labels.baseline);
	const after = asSuiteRun(current, labels.current);
	const comparison = compareRuns(before, after);

	return {
		text: describeComparison(before, after, comparison),
		blocking: comparison.regressed,
	};
}
