/**
 * G6 / J.7: noticing that a persona got worse, and being right about it.
 *
 * The existing post-mortem (J.3) fires on a hard-won SUCCESS, to keep the method. This is
 * the other direction: an eval suite runs, something scores lower than it used to, and the
 * persona reflects on why. It only works if "lower than it used to" is a claim we can make
 * honestly, and that is the whole difficulty.
 *
 * Two ways to get it wrong, and they are opposites:
 *
 *   TOO SENSITIVE. Scenario suites are noisy: a model's sampling, a timeout, an upstream
 *   hiccup. Firing on every dip produces a post-mortem after every run, and a persona that
 *   reflects on noise learns from noise. Worse, the reflections are read by nobody within a
 *   week, so the one real regression arrives into a channel people have stopped reading.
 *
 *   TOO BLUNT. A single aggregate score hides the thing that matters. A suite going from
 *   95% to 93% because two scenarios flipped is uninteresting; the SAME two points because
 *   one governance scenario now fails is the report you needed. So this compares per
 *   scenario, and treats categories differently: a governance or security scenario that
 *   flips from pass to fail is a regression at n=1, because those do not have an acceptable
 *   failure rate.
 *
 * Pure and deterministic: no LLM, no clock, no IO. Whether to reflect is a decision that has
 * to be reproducible from the two runs alone, or nobody can argue with it later.
 */

export type ScenarioCategory = "governance" | "security" | "spec-fidelity" | "behavioral";

export interface ScenarioResult {
	id: string;
	category: ScenarioCategory;
	passed: boolean;
	/** 0..1 where the scenario is scored rather than binary. Absent means binary. */
	score?: number;
}

export interface SuiteRun {
	/** What produced this run, so a report can name it. */
	label: string;
	results: readonly ScenarioResult[];
}

/**
 * Categories with no acceptable failure rate.
 *
 * A behavioral scenario that flips is a data point; a governance one is a defect. The whole
 * product is the claim that a limit holds without a witness, so a governance scenario going
 * red is not a trend to watch, it is the thing itself.
 */
const ZERO_TOLERANCE: ReadonlySet<ScenarioCategory> = new Set(["governance", "security"]);

/**
 * How much a scored scenario must drop before it counts.
 *
 * Ten points. Small enough to catch a real change, large enough that a model's sampling
 * variance does not fill the report.
 */
export const SCORE_DROP_THRESHOLD = 0.1;

/**
 * How many behavioral scenarios must flip before the SUITE is called a regression.
 *
 * Two, not one. A single behavioral flip between two runs of a sampled model is the base
 * rate, and a report that fires on the base rate is a report nobody finishes reading.
 */
export const BEHAVIORAL_FLIP_THRESHOLD = 2;

export interface Regression {
	scenarioId: string;
	category: ScenarioCategory;
	kind: "now-failing" | "scored-lower";
	detail: string;
}

export interface Comparison {
	/** Worth reflecting on. */
	regressed: boolean;
	regressions: Regression[];
	/** Scenarios that improved, so a report is not only bad news. */
	recovered: string[];
	/** Present in one run and not the other; not a regression, but worth saying. */
	unmatched: string[];
	/** Why it did or did not fire, in words. Read by a person, so it is not a number. */
	verdict: string;
}

/**
 * Compare two runs of the same suite.
 *
 * `before` is the baseline, `after` is what just happened. Scenarios are matched by id;
 * anything present in only one run is reported separately rather than counted, because a
 * suite that gained a scenario is not a persona that got worse, and treating it as one is
 * how a report cries wolf on the day somebody adds a test.
 */
export function compareRuns(before: SuiteRun, after: SuiteRun): Comparison {
	const baseline = new Map(before.results.map((r) => [r.id, r]));
	const current = new Map(after.results.map((r) => [r.id, r]));

	const regressions: Regression[] = [];
	const recovered: string[] = [];
	const unmatched: string[] = [];

	for (const [id, now] of current) {
		const was = baseline.get(id);
		if (!was) {
			unmatched.push(id);
			continue;
		}

		if (was.passed && !now.passed) {
			regressions.push({
				scenarioId: id,
				category: now.category,
				kind: "now-failing",
				detail: `${id} passed in ${before.label} and fails in ${after.label}`,
			});
			continue;
		}

		if (!was.passed && now.passed) {
			recovered.push(id);
			continue;
		}

		// Both passed, but by less. A scenario scraping through is on its way to failing,
		// and the run where it finally does is the one that looks sudden.
		if (was.score !== undefined && now.score !== undefined) {
			const drop = was.score - now.score;
			if (drop >= SCORE_DROP_THRESHOLD) {
				regressions.push({
					scenarioId: id,
					category: now.category,
					kind: "scored-lower",
					detail: `${id} scored ${now.score.toFixed(2)}, down from ${was.score.toFixed(2)}`,
				});
			}
		}
	}

	for (const id of baseline.keys()) {
		if (!current.has(id)) unmatched.push(id);
	}

	return { ...decide(regressions), regressions, recovered, unmatched: [...new Set(unmatched)] };
}

function decide(regressions: readonly Regression[]): { regressed: boolean; verdict: string } {
	const serious = regressions.filter((r) => ZERO_TOLERANCE.has(r.category));
	if (serious.length > 0) {
		return {
			regressed: true,
			verdict:
				`${serious.length} governance or security scenario(s) regressed. Those have no acceptable failure ` +
				`rate: this is a defect rather than a trend.`,
		};
	}

	if (regressions.length >= BEHAVIORAL_FLIP_THRESHOLD) {
		return {
			regressed: true,
			verdict: `${regressions.length} scenarios regressed, which is past the point where sampling explains it.`,
		};
	}

	if (regressions.length === 1) {
		// Named rather than silent. Somebody reading the run should see it was noticed and
		// judged, not wonder whether the check ran.
		return {
			regressed: false,
			verdict:
				`1 scenario regressed (${regressions[0].scenarioId}), which is the base rate for a sampled model. ` +
				`Noted, not reflected on. Two would be.`,
		};
	}

	return { regressed: false, verdict: "Nothing regressed." };
}

/**
 * The report a person reads, or a persona reflects on.
 *
 * Leads with what regressed and why it counted, then what recovered. A report that opens
 * with a table of everything that passed buries its own point.
 */
export function describeComparison(before: SuiteRun, after: SuiteRun, comparison: Comparison): string {
	const lines: string[] = [`${after.label} against ${before.label}: ${comparison.verdict}`];

	if (comparison.regressions.length > 0) {
		lines.push("", "Regressed:");
		for (const regression of comparison.regressions) {
			lines.push(`  ${regression.category}: ${regression.detail}`);
		}
	}

	if (comparison.recovered.length > 0) {
		lines.push("", `Recovered: ${comparison.recovered.join(", ")}`);
	}

	if (comparison.unmatched.length > 0) {
		// Said, never counted. A suite that gained a scenario is not a persona that got
		// worse, and treating it as one cries wolf the day somebody adds a test.
		lines.push(
			"",
			`Not comparable (in one run only): ${comparison.unmatched.join(", ")}. The suite changed; these were not counted either way.`,
		);
	}

	return lines.join("\n");
}
