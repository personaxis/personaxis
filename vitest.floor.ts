/**
 * Coverage floors, in one file, for every package that has tests.
 *
 * A threshold scattered across nine configs is nine numbers nobody compares. Here
 * they sit in a column, so the shape of the repository is readable at a glance: the
 * engine is covered, the surface a person actually types at is not.
 *
 * ## What these numbers are, and what they are not
 *
 * Each floor is the measurement of 2026-08-29 rounded down by a point, so ordinary
 * cross-platform noise cannot fail a run that changed nothing. **A floor only ever
 * moves up.** Lowering one is a visible edit in this file, which is the point: the
 * failure mode of a threshold is not that somebody breaks it, it is that somebody
 * quietly relaxes it, and that has to cost a line in a diff.
 *
 * Line coverage here is doing a second job. Read next to `designed-not-connected`
 * (which finds a module with no caller) and the schema sweep in the platform repo
 * (a column with no reader), a file at 0% lines is the same finding a third time: it
 * exists, it type-checks, it ships, and nothing has ever run it. That is why the
 * floors carry `lines` at all, given how weak a quality signal line coverage is on
 * its own.
 *
 * ## Two numbers here are honest but not comparable
 *
 * **`cli` reads low because of how it is tested, not how well.** Sixteen suites drive
 * the commands by spawning `node dist/index.js` and asserting on real output, and V8
 * coverage in the parent process cannot see a child process. Every command file
 * therefore reports 0% while being exercised end to end. Measured: 49 of 156 source
 * files at zero, and the same run shows 74% branch and 75% function coverage, which is
 * the giveaway. Capturing the child would mean `NODE_V8_COVERAGE` plus source maps in
 * the published build, which is a change to what ships and belongs in its own task.
 * Until then this floor guards against regression only, and is not a quality claim.
 *
 * **`spec` is genuinely low.** It is a schema package whose source is mostly branches
 * for cases the suite does not reach.
 */

export interface Floor {
	readonly lines: number;
	readonly branches: number;
	readonly functions: number;
}

/** Measured 2026-08-29 across 2,162 tests. Rounded down one point. */
export const FLOORS = {
	// The engine. Where the work of phases 01 to 08 landed, and it shows.
	core: { lines: 87, branches: 83, functions: 91 },
	protocol: { lines: 87, branches: 78, functions: 94 },
	evals: { lines: 86, branches: 81, functions: 78 },
	sdk: { lines: 84, branches: 80, functions: 71 },

	// The surfaces.
	tui: { lines: 73, branches: 77, functions: 71 },
	mcp: { lines: 71, branches: 73, functions: 69 },

	// See the note above before reading either of these as a quality number.
	cli: { lines: 39, branches: 72, functions: 73 },
	spec: { lines: 20, branches: 58, functions: 45 },
} as const satisfies Record<string, Floor>;

/**
 * The coverage block for one package.
 *
 * `include` is explicit so that a file no test ever loads still counts against the
 * floor. Without it V8 reports only what was imported, every untouched file vanishes
 * from the denominator, and the number climbs as the code gets less tested, which is
 * the exact opposite of what a floor is for.
 */
export function coverage(pkg: keyof typeof FLOORS) {
	const floor = FLOORS[pkg];
	return {
		provider: "v8" as const,
		include: ["src/**"],
		// Generated at build time from the package manifest; nothing to test.
		exclude: ["src/generated/**", "**/*.d.ts"],
		reporter: ["text-summary" as const],
		thresholds: {
			lines: floor.lines,
			statements: floor.lines, // v8 counts a statement per line
			branches: floor.branches,
			functions: floor.functions,
		},
	};
}
