/**
 * E92: a live recompile writes the document `compile` writes.
 *
 * Measured on 2026-09-14: a persona crossed a band on its first TUI turn, the living loop rewrote
 * its `PERSONA.md`, and the new document had lost the header with its skill list and the resource
 * lines naming its skills and references. The model reads that document as who it is, so the
 * persona stopped seeing what it had. Two paths built the document and only one of them passed the
 * manifest, the header and the skills.
 *
 * The strongest check is the one that makes drift impossible to miss: for the same spec and the
 * same state, the live document is byte for byte the file `compile --no-polish` writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

import { ensureState, run } from "@personaxis/core";

import { compiledPathFor, loadPersonaFile } from "../src/load.js";
import { writeStarterPersona } from "../src/starter.js";
import { runCompile } from "../src/commands/compile.js";
import { liveCompiledDocument } from "../src/compiled-document.js";
import { recompileHookFor } from "../src/repl/session.js";

let base: string;
let savedCwd: string;
let savedPxsHome: string | undefined;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "pxs-compiled-doc-"));
	savedCwd = process.cwd();
	savedPxsHome = process.env.PERSONAXIS_HOME;
	process.env.PERSONAXIS_HOME = join(base, "pxs-config"); // isolate model config
});

afterEach(() => {
	process.chdir(savedCwd);
	if (savedPxsHome === undefined) delete process.env.PERSONAXIS_HOME;
	else process.env.PERSONAXIS_HOME = savedPxsHome;
	rmSync(base, { recursive: true, force: true });
});

/** A persona that declares one local skill and one reference, with both on disk. */
function withSkillAndReference(repo: string, subSlug?: string): string {
	const path = subSlug ? writeStarterPersona(repo, "Wright", subSlug) : writeStarterPersona(repo, "Wright");
	const spec = readFileSync(path, "utf-8")
		.replace("  skills: []", '  skills:\n    - "./skills/level-pacing"')
		.replace("  references: []", '  references:\n    - "references/pacing-notes.md"');
	writeFileSync(path, spec);
	const dir = subSlug ? join(repo, ".personaxis", "personas", subSlug) : join(repo, ".personaxis");
	mkdirSync(join(dir, "skills", "level-pacing"), { recursive: true });
	writeFileSync(
		join(dir, "skills", "level-pacing", "SKILL.md"),
		"---\nname: level-pacing\ndescription: Pace a level so difficulty rises with the player's skill. Use when designing a level.\n---\n\n# Level pacing\n",
	);
	mkdirSync(join(dir, "references"), { recursive: true });
	writeFileSync(join(dir, "references", "pacing-notes.md"), "# Pacing notes\n");
	return path;
}

const specOf = (path: string) => loadPersonaFile(path).data as Record<string, unknown>;

describe("the live compiled document (E92)", () => {
	it("keeps the sub-persona header, its skill list and its resources", () => {
		const path = withSkillAndReference(join(base, "repo"), "wright");
		const { data, content } = matter(liveCompiledDocument(path, specOf(path)));

		expect(data.name).toBe("wright");
		expect(data.skills).toEqual(["level-pacing"]);
		expect(content).toContain("`./references/`");
		expect(content).toContain("`pacing-notes.md`");
		expect(content).toContain("`./skills/`");
		expect(content).toContain("`level-pacing/`");
	});

	it("names only the skills that exist, the same selection compile copies", () => {
		const path = withSkillAndReference(join(base, "repo"), "wright");
		writeFileSync(path, readFileSync(path, "utf-8").replace('    - "./skills/level-pacing"', '    - "./skills/level-pacing"\n    - "./skills/not-written-yet"'));
		const { data } = matter(liveCompiledDocument(path, specOf(path)));
		expect(data.skills).toEqual(["level-pacing"]);
	});

	it("is byte for byte what compile writes without a model, for a sub-persona", async () => {
		const repo = join(base, "repo");
		const path = withSkillAndReference(repo, "wright");
		process.chdir(repo);
		await runCompile({ slug: "wright", noPolish: true });

		const written = readFileSync(compiledPathFor(path), "utf-8");
		expect(liveCompiledDocument(path, specOf(path)).trimEnd() + "\n").toBe(written);
	});

	it("is what the session's own recompile hook writes over a stale document", async () => {
		// The hook `makeCtx` hands the living loop, not a copy of it. A session that went back to
		// assembling the document by hand would pass every test above and fail this one.
		const repo = join(base, "repo");
		const path = withSkillAndReference(repo, "wright");
		process.chdir(repo);
		// State first, so the compile and the hook read the same values and the same disk.
		ensureState(run.assemble(path).handle);
		await runCompile({ slug: "wright", noPolish: true });

		const compiledPath = compiledPathFor(path);
		const written = readFileSync(compiledPath, "utf-8");
		writeFileSync(compiledPath, "stale\n");
		await recompileHookFor(path, compiledPath)(run.assemble(path).handle);

		expect(readFileSync(compiledPath, "utf-8")).toBe(written);
		expect(matter(written).data.skills).toEqual(["level-pacing"]);
	});

	it("is byte for byte what compile writes without a model, for the root persona", async () => {
		const repo = join(base, "repo");
		const path = withSkillAndReference(repo);
		process.chdir(repo);
		await runCompile({ root: true, noPolish: true });

		const written = readFileSync(compiledPathFor(path), "utf-8");
		const live = liveCompiledDocument(path, specOf(path));
		expect(live.startsWith("---")).toBe(false);
		expect(live).toContain("`pacing-notes.md`");
		expect(live.trimEnd() + "\n").toBe(written);
	});
});
