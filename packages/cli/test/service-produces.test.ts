/**
 * The disk side of a step's declared files (E60): what `personaxis service run` counts as written.
 *
 * The rule itself, a step that declares a file and does not leave it fails, is in core's
 * `compose.test.ts` against a folder in memory. This is the port that reads a real one, with the
 * times set by hand, because "written during the step" is a claim about timestamps and a test that
 * only ever wrote fresh files could not tell a check on the time from no check at all.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { producedIn } from "../src/commands/service.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "px-produces-"));
	mkdirSync(join(root, "docs"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("what counts as a file a step wrote", () => {
	it("counts a file written after the step began, with its size", () => {
		const since = Date.now() - 1000;
		writeFileSync(join(root, "docs", "refunds.md"), "# Refunds\n");
		expect(producedIn(root, ["docs/refunds.md"], since)).toEqual({
			produced: [{ path: "docs/refunds.md", bytes: 10 }],
			missing: [],
		});
	});

	it("does not count a file that was already there, however it is named", () => {
		writeFileSync(join(root, "docs", "CHANGELOG.md"), "old");
		const old = new Date(Date.now() - 60_000);
		utimesSync(join(root, "docs", "CHANGELOG.md"), old, old);
		expect(producedIn(root, ["docs/CHANGELOG.md"], Date.now() - 1000).missing).toEqual(["docs/CHANGELOG.md"]);
	});

	it("does not count a file that is not there", () => {
		expect(producedIn(root, ["docs/refunds.md"], 0).missing).toEqual(["docs/refunds.md"]);
	});

	it("does not count a folder with the file's name", () => {
		mkdirSync(join(root, "docs", "refunds.md"));
		expect(producedIn(root, ["docs/refunds.md"], 0).missing).toEqual(["docs/refunds.md"]);
	});

	it("does not look outside the service's folder, even at a file that is there", () => {
		// A sibling of the folder, written just now: present, fresh, and still not this service's.
		const outside = join(root, "..", `${root.split(/[\\/]/).pop()}-sibling.md`);
		writeFileSync(outside, "x");
		try {
			expect(producedIn(root, [`../${outside.split(/[\\/]/).pop()}`], 0).missing).toHaveLength(1);
		} finally {
			rmSync(outside, { force: true });
		}
	});
});
