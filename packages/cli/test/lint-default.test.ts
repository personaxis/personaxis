/**
 * E169: `lint` with no file lints the persona's source of truth, as `validate` does.
 *
 * Seen on 2026-10-03 in the end-to-end run before the first release: `create` left a valid persona and said "1 lint
 * warning", and `lint` right after failed with eight errors, because with no file it read `./PERSONA.md`, the compiled
 * prose document, which has no frontmatter since spec v1. A repository from before v1, with only a `PERSONA.md` that
 * carries the frontmatter, is still linted.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { writeStarterPersona } from "../src/starter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "index.js");
let dir = "";
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

const lintJson = (cwd: string) => {
	const run = spawnSync(process.execPath, [CLI, "lint", "--format", "json"], { cwd, encoding: "utf8", env: { ...process.env, PERSONAXIS_NO_UPDATE_CHECK: "1", NO_COLOR: "1" } });
	return { code: run.status, report: JSON.parse(run.stdout || "{}") as { summary?: { errors: number }; findings?: Array<{ rule: string }> } };
};

describe.skipIf(!existsSync(CLI))("lint with no file (E169)", () => {
	it("lints .personaxis/personaxis.md, not the compiled PERSONA.md beside it", () => {
		dir = mkdtempSync(join(tmpdir(), "pxs-lint-"));
		writeStarterPersona(dir, "Vega");
		// What `compile` writes at the root: prose, no frontmatter.
		writeFileSync(join(dir, "PERSONA.md"), "# Vega\n\nVega is a careful designer who checks before shipping.\n");

		const { code, report } = lintJson(dir);
		expect(report.findings?.map((f) => f.rule)).not.toContain("apiVersion");
		expect(report.summary?.errors).toBe(0);
		expect(code).toBe(0);
	}, 30_000);

	it("still lints a repository from before spec v1, whose only persona file is PERSONA.md with frontmatter", () => {
		dir = mkdtempSync(join(tmpdir(), "pxs-lint-legacy-"));
		const source = writeStarterPersona(dir, "Vega");
		writeFileSync(join(dir, "PERSONA.md"), readFileSync(source, "utf8"));
		rmSync(join(dir, ".personaxis"), { recursive: true, force: true });

		const { report } = lintJson(dir);
		expect(report.summary).toBeDefined();
		expect(report.findings?.map((f) => f.rule)).not.toContain("apiVersion");
	}, 30_000);
});
