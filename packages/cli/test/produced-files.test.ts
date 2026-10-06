// What a step left behind, named without being sent.
//
// A service step's real output is usually a file, and the workspace could not name one:
// the delivery said "it is in your folder", which was true and was all it could say. A
// person reading a finished delivery had no idea whether it had produced three files or
// none.
//
// The bytes stay on the operator's machine and that is the design, not a shortcut. The
// connected mode is sold on nothing leaving that computer, so what crosses the wire is
// that a file exists, what kind it is and how big. These tests are mostly about the
// limits, because a scan of somebody else's repository is where an unbounded read would
// do the most damage.

import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	describeFile,
	kindOf,
	producedBetween,
	scanDirectory,
} from "../src/workspace/produced-files.js";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "produced-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("scanning a project directory", () => {
	it("reports a relative path and never an absolute one", async () => {
		// An absolute path carries the operator's home directory, their username and
		// often their employer. None of that is what the workspace asked for, and all
		// of it would end up in a record nobody can edit afterwards.
		await mkdir(join(root, "notes"), { recursive: true });
		await writeFile(join(root, "notes", "brief.md"), "hello");

		const scan = await scanDirectory(root);

		expect(scan.files.map((file) => file.path)).toEqual(["notes/brief.md"]);
		expect(scan.files[0]?.path.includes(root)).toBe(false);
	});

	it("uses forward slashes on every platform", async () => {
		// The path is read by a workspace that may be on another operating system, so
		// a Windows daemon must not send `notes\brief.md` to a Linux screen.
		await mkdir(join(root, "a", "b"), { recursive: true });
		await writeFile(join(root, "a", "b", "c.txt"), "x");

		const scan = await scanDirectory(root);

		expect(scan.files[0]?.path).toBe("a/b/c.txt");
	});

	it("does not walk into the directories that churn", async () => {
		// Not an optimisation. A step that ran an install would otherwise report forty
		// thousand files it did not write, and the one file it did write would be
		// somewhere in the middle of them.
		for (const noisy of ["node_modules", ".git", "dist"]) {
			await mkdir(join(root, noisy), { recursive: true });
			await writeFile(join(root, noisy, "junk.txt"), "x");
		}
		await writeFile(join(root, "real.md"), "x");

		const scan = await scanDirectory(root);

		expect(scan.files.map((file) => file.path)).toEqual(["real.md"]);
	});

	it("stops at a ceiling and says that it did", async () => {
		// The answer becomes "at least this many", which is a smaller lie than a
		// delivery that takes a minute to assemble.
		for (let index = 0; index < 205; index += 1) {
			await writeFile(join(root, `f${index}.txt`), "x");
		}

		const scan = await scanDirectory(root);

		expect(scan.files.length).toBe(200);
		expect(scan.capped).toBe(true);
	});

	it("survives a directory it cannot read", async () => {
		// A real thing on somebody's machine. Failing the whole scan because of one
		// unreadable directory would lose the report for every file that was readable.
		await writeFile(join(root, "kept.md"), "x");

		const scan = await scanDirectory(join(root, "does-not-exist"));

		expect(scan.files).toEqual([]);
		expect(scan.capped).toBe(false);
	});
});

describe("what the step produced", () => {
	it("names a file that appeared", async () => {
		const before = await scanDirectory(root);
		await writeFile(join(root, "new.md"), "written by the step");
		const after = await scanDirectory(root);

		expect(producedBetween(before, after).map((file) => file.path)).toEqual(["new.md"]);
	});

	it("names a file that was rewritten", async () => {
		await writeFile(join(root, "notes.md"), "first");
		const before = await scanDirectory(root);

		// The timestamp is moved explicitly: two writes inside the same millisecond
		// are indistinguishable, and a test that depends on the clock being slow is a
		// test that fails on a fast machine.
		await writeFile(join(root, "notes.md"), "second, longer");
		const when = new Date(Date.now() + 5_000);
		await utimes(join(root, "notes.md"), when, when);

		const after = await scanDirectory(root);

		expect(producedBetween(before, after).map((file) => file.path)).toEqual(["notes.md"]);
	});

	it("says nothing about a file the step only read", async () => {
		await writeFile(join(root, "input.md"), "already here");
		const before = await scanDirectory(root);
		const after = await scanDirectory(root);

		expect(producedBetween(before, after)).toEqual([]);
	});

	it("says nothing about a deletion", async () => {
		// This answers "what did the step leave", and a deletion leaves nothing to
		// open. It belongs in the record as a tool call, not here.
		await writeFile(join(root, "gone.md"), "x");
		const before = await scanDirectory(root);
		await rm(join(root, "gone.md"));
		const after = await scanDirectory(root);

		expect(producedBetween(before, after)).toEqual([]);
	});
});

describe("describing a file without quoting it", () => {
	it("names a kind from the extension and refuses to guess", () => {
		expect(kindOf("notes.md")).toBe("markdown");
		expect(kindOf("report.PDF")).toBe("pdf");
		expect(kindOf("rows.csv")).toBe("table");
		expect(kindOf("change.patch")).toBe("diff");
		// `json` on something that turned out to be a log is worse than no claim.
		expect(kindOf("server.log")).toBe("file");
		expect(kindOf("Makefile")).toBe("file");
	});

	it("describes rather than samples", () => {
		// The first kilobyte of a file is the file, and the contents are exactly what
		// does not travel.
		const said = describeFile({ path: "brief.md", bytes: 4_812, modifiedAt: 0 });

		expect(said).toContain("markdown");
		expect(said).toContain("4.7 KB");
		expect(said).not.toContain("brief.md");
	});
});
