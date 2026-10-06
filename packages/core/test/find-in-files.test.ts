/**
 * C5: finding where something is, without reading everything.
 *
 * The catalogue had `list_dir` and `read_file` and nothing between them. A persona with
 * a shell could fall back to `grep`; a `read-only` persona has no shell, so it had no
 * way to search at all and its only option was to read files whole until one matched,
 * which is the context this exists to save.
 *
 * These run against a real directory through the local port, because what the tool
 * does IS walk a filesystem: a mocked port would be asserting the shape of my own
 * fixture, which is the failure the morning's `deliver.ts` bug was made of.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findInFilesTool } from "../src/tools/builtin/find-in-files.js";
import { localExecution } from "../src/ports/execution.js";
import { DEFAULT_POLICY, type Policy } from "../src/sandbox.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-find-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const policy = (): Policy => ({ ...DEFAULT_POLICY, workspaceRoot: dir });

const write = (relative: string, content: string | Buffer) => {
	const full = join(dir, relative);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
};

const find = (text: string, path?: string) =>
	findInFilesTool.execute(
		path === undefined ? { text } : { text, path },
		policy(),
		localExecution(),
	);

describe("finding text across files", () => {
	it("says which file and which line", async () => {
		write("src/app.ts", "const x = 1;\nexport function boot() {}\n");
		write("README.md", "nothing here\n");

		const said = await find("boot");

		expect(said).toContain("src/app.ts:2");
		expect(said).toContain("export function boot");
	});

	it("looks in subdirectories, which is the whole point", async () => {
		write("a/b/c/deep.ts", "const marker = true;\n");

		expect(await find("marker")).toContain("a/b/c/deep.ts:1");
	});

	it("says plainly when nothing contains it", async () => {
		write("only.ts", "nothing of interest\n");

		expect(await find("absent")).toContain("no file contains");
	});

	it("matches the text literally, not as a regular expression", async () => {
		// The security decision, asserted as behaviour. A pattern the model wrote is
		// untrusted input, and an untrusted regular expression can be made to backtrack
		// catastrophically: one line of a checked-in file is enough to hang a run.
		write("code.ts", "const abc = 1;\n");

		expect(await find("a.c")).toContain("no file contains");
	});

	it("skips node_modules and .git, and says it did", async () => {
		write("node_modules/pkg/index.js", "const needle = 1;\n");
		write(".git/config", "needle\n");
		write("mine.ts", "const needle = 2;\n");

		const said = await find("needle");

		expect(said).toContain("mine.ts:1");
		// The skipped file, not the word: the note at the bottom names the two
		// directories on purpose, so asserting the word absent would be asserting that
		// the answer stops explaining itself.
		expect(said).not.toContain("node_modules/pkg/index.js");
		expect(said).not.toContain(".git/config");
		expect(said).toContain("not searched");
	});

	it("does not find a match inside a binary", async () => {
		// A binary answers with a SENTENCE about itself rather than its bytes, so a
		// search that read `content` naively would report a hit inside an image for
		// anything appearing in that sentence. Skipped by the reader's flag, never by
		// matching its words.
		write("image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x62, 0x79, 0x74, 0x65, 0x73]));

		expect(await find("bytes")).toContain("no file contains");
	});

	it("still finds text in a file with accents", async () => {
		// The control on the binary rule: most of what this product writes is accented,
		// and a detector that called those binary would make the search useless.
		write("prosa.md", "el camión llegó tarde\n");

		expect(await find("camión")).toContain("prosa.md:1");
	});

	it("says it stopped early rather than letting silence read as absence", async () => {
		// The difference between "it is not here" and "I stopped looking", which a model
		// acts on very differently.
		write("many.ts", Array.from({ length: 200 }, (_, i) => `const needle${i} = 1;`).join("\n"));

		const said = await find("needle");

		expect(said).toContain("hit its ceiling");
	});

	it("cuts a line that is a whole minified bundle", async () => {
		write("bundle.js", `const needle=1;${"x".repeat(5_000)}\n`);

		const said = await find("needle");

		expect(said.length).toBeLessThan(1_000);
		expect(said).toContain("…");
	});

	it("searches from where it was pointed, and not above it", async () => {
		write("inside/here.ts", "const needle = 1;\n");
		write("elsewhere/there.ts", "const needle = 2;\n");

		const said = await find("needle", "inside");

		expect(said).toContain("inside/here.ts:1");
		expect(said).not.toContain("elsewhere");
	});

	it("refuses empty text instead of matching every line", async () => {
		write("a.ts", "anything\n");

		expect(await find("")).toContain("needs some text");
	});

	it("is read-only and parallel-safe, which is what lets a read-only persona have it", () => {
		expect(findInFilesTool.isReadOnly).toBe(true);
		expect(findInFilesTool.isConcurrencySafe).toBe(true);
	});
});
