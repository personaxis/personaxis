// A package with tests and no floor.
//
// The threshold in `vitest.floor.ts` defends against coverage falling. It cannot
// defend against a package that was never in the table: a new package arrives with a
// `test` script, its suite is green, CI is green, and nothing anywhere measures what
// those tests touch. That is not a regression a threshold can catch, because there is
// no threshold. It is the same hole `designed-not-connected` watches one level up,
// where the thing that goes missing is the wiring rather than the code.
//
// So this asserts the wiring itself: every package that runs tests is in the table,
// every entry in the table has a `test:coverage` script to be measured by, and every
// such package's vitest config actually asks for it. Break any one of the three and
// the floor silently stops applying to that package while everything still passes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FLOORS } from "../../../vitest.floor";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");

/** Directory name to package, for the packages that ship tests. */
const TESTED = ["cli", "core", "tui", "sdk", "mcp", "protocol", "spec", "evals"] as const;

function manifest(pkg: string): { scripts?: Record<string, string> } {
	return JSON.parse(readFileSync(join(PACKAGES, pkg, "package.json"), "utf8"));
}

function config(pkg: string): string {
	return readFileSync(join(PACKAGES, pkg, "vitest.config.ts"), "utf8");
}

describe("the coverage floor covers everything that has tests", () => {
	it("names every tested package, so a new one cannot arrive unmeasured", () => {
		// If this fails after adding a package, the fix is a row in vitest.floor.ts
		// measured from a real run, not a row copied from a neighbour.
		expect(Object.keys(FLOORS).sort()).toEqual([...TESTED].sort());
	});

	it.each(TESTED)("%s has a test:coverage script that asks for coverage", (pkg) => {
		const scripts = manifest(pkg).scripts ?? {};
		expect(scripts.test, `${pkg} is listed as tested but has no test script`).toBeTruthy();
		expect(scripts["test:coverage"], `${pkg} has no test:coverage script`).toContain("--coverage");
	});

	it.each(TESTED)("%s wires its config to the shared floor", (pkg) => {
		// Reading the file rather than importing the config: a config that imports
		// `coverage()` and then never calls it would still type-check, and the string
		// is what makes the intent visible in a diff.
		expect(config(pkg)).toContain(`coverage("${pkg}")`);
	});

	it("has no floor of zero, which would be a row that defends nothing", () => {
		for (const [pkg, floor] of Object.entries(FLOORS)) {
			expect(floor.lines, `${pkg} lines`).toBeGreaterThan(0);
			expect(floor.branches, `${pkg} branches`).toBeGreaterThan(0);
			expect(floor.functions, `${pkg} functions`).toBeGreaterThan(0);
		}
	});
});
