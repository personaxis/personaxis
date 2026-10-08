/**
 * `personaxis init`: this folder's persona, the way `/init` gives a repository its CLAUDE.md. A model reads
 * the folder, takes what you say it is for, and writes the persona and its PERSONA.md; the folder is read
 * whatever else is given, bounded, and never in the home folder.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { folderContext } from "../src/commands/create.js";
import { modelEnv, runCli, startFakeModel, type FakeModel } from "./helpers/fake-model.js";
import { writeTestPersona } from "./helpers/test-persona.js";

const CLI = join(process.cwd(), "dist", "index.js");
let dir = "";
let home = "";
let model: FakeModel | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-init-"));
	home = mkdtempSync(join(tmpdir(), "pxs-init-home-"));
});
afterEach(async () => {
	await model?.close();
	model = undefined;
	rmSync(dir, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

describe("folderContext", () => {
	it("reads the tree, the files that explain the project and the personas already there, and skips build output", () => {
		writeFileSync(join(dir, "README.md"), "# Ledger\n\nA payments ledger service.");
		writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = \"ledger\"");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "ledger.py"), "");
		mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
		writeTestPersona(dir, "Helper", "helper");

		const context = folderContext(dir)!;
		expect(context.files).toEqual(["README.md", "pyproject.toml"]);
		expect(context.text).toContain("A payments ledger service.");
		expect(context.text).toContain("src/ledger.py");
		expect(context.text).not.toContain("left-pad");
		expect(context.text).toContain("PERSONAS ALREADY HERE:\n- .personaxis/personas/helper/personaxis.md:");
	});

	it("reads nothing in an empty folder or the home folder", () => {
		expect(folderContext(dir)).toBeUndefined();
		expect(folderContext(homedir())).toBeUndefined();
	});
});

describe("personaxis init", () => {
	it("writes this folder's persona from the folder and the intent, with its PERSONA.md and its sources", async () => {
		writeFileSync(join(dir, "README.md"), "# Ledger\n\nA payments ledger service. Every change to money needs a test of its failure path.");
		model = await startFakeModel();
		const r = await runCli(CLI, ["init", "A terse code reviewer that never softens findings", "--yes"], { cwd: dir, env: { PERSONAXIS_HOME: home, ...modelEnv(model) } });
		expect(r.code, r.out).toBe(0);
		expect(r.out).toContain("reading this folder: README.md");

		expect(existsSync(join(dir, ".personaxis", "personaxis.md"))).toBe(true);
		expect(readFileSync(join(dir, "PERSONA.md"), "utf-8")).toContain("# You are Terse Code Reviewer");
		const spec = readFileSync(join(dir, ".personaxis", "personaxis.md"), "utf-8");
		expect(spec).toContain("- S1: this folder");
		expect(spec).toContain("- S2: what you asked for");
		// The model was handed the folder.
		expect(JSON.stringify(model.requests[0])).toContain("Every change to money needs a test of its failure path.");
	}, 120_000);

	it("refuses with nothing to create from: no project, no intent, no terminal", async () => {
		model = await startFakeModel();
		const r = await runCli(CLI, ["init", "--yes"], { cwd: dir, env: { PERSONAXIS_HOME: home, ...modelEnv(model) } });
		expect(r.code).toBe(1);
		expect(r.out).toContain("nothing to create from");
		expect(existsSync(join(dir, ".personaxis", "personaxis.md"))).toBe(false);
	}, 60_000);
});
