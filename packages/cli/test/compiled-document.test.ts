/**
 * E92: the compiled document keeps what the persona has, whoever writes it and whenever.
 *
 * Measured on 2026-09-14: a persona crossed a band on its first TUI turn, the living loop rewrote
 * its `PERSONA.md`, and the new document had lost the header with its skill list and the resource
 * lines naming its skills and references. The model reads that document as who it is, so the
 * persona stopped seeing what it had. Two paths built the document and only one of them passed the
 * manifest, the header and the skills.
 *
 * Since 2026-10-07 a model writes every compiled document, in session too: a crossing marks it stale
 * and starts the same `compile` in the background. What keeps the skills and resources now is the
 * reference both paths build (`assembleInputFor`), the dressing `compile` puts in front, and the
 * faithfulness check, which rejects a document that drops a "Memory & resources" line.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

import { assemblePersonaDoc, checkFaithfulness, compiledHistory, ensureState, markRecompilePending, readRecompilePending, run } from "@personaxis/core";

import { compiledPathFor, loadPersonaFile } from "../src/load.js";
import { writeStarterPersona } from "../src/starter.js";
import { runCompile } from "../src/commands/compile.js";
import { assembleInputFor } from "../src/compiled-document.js";
import { recompileHookFor } from "../src/repl/session.js";
import { modelEnv, startFakeModel, type FakeModel } from "./helpers/fake-model.js";

let base: string;
let savedCwd: string;
let savedPxsHome: string | undefined;
let model: FakeModel | undefined;
const savedModelEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "pxs-compiled-doc-"));
	savedCwd = process.cwd();
	savedPxsHome = process.env.PERSONAXIS_HOME;
	process.env.PERSONAXIS_HOME = join(base, "pxs-config"); // isolate model config
});

afterEach(async () => {
	await model?.close();
	model = undefined;
	for (const [k, v] of Object.entries(savedModelEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
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
/** The reference the code assembles for a persona: what its document must carry. */
const referenceOf = (path: string) => assemblePersonaDoc(assembleInputFor(path, specOf(path)));

/** A model for this process that writes `document` whenever it is asked for a PERSONA.md. */
async function modelWriting(document: string): Promise<void> {
	model = await startFakeModel({ document });
	for (const [k, v] of Object.entries(modelEnv(model))) {
		savedModelEnv[k] = process.env[k];
		process.env[k] = v;
	}
}

describe("the compiled document keeps what the persona has (E92)", () => {
	it("the reference names the skills and the references, so the check holds a document to them", () => {
		const path = withSkillAndReference(join(base, "repo"), "wright");
		const reference = referenceOf(path);
		expect(reference).toContain("`./references/`");
		expect(reference).toContain("`pacing-notes.md`");
		expect(reference).toContain("`./skills/`");
		expect(reference).toContain("`level-pacing/`");
	});

	it("rejects a document that drops a Memory & resources line", () => {
		const path = withSkillAndReference(join(base, "repo"), "wright");
		const reference = referenceOf(path);
		const lost = reference.split("\n").filter((line) => !line.includes("pacing-notes.md")).join("\n");
		const report = checkFaithfulness(reference, lost);
		expect(report.ok).toBe(false);
		expect(report.findings.some((f) => f.kind === "dropped" && f.section === "memory & resources")).toBe(true);
	});

	it("compile puts the sub-persona header and the skills that exist in front of the model's document", async () => {
		const repo = join(base, "repo");
		const path = withSkillAndReference(repo, "wright");
		writeFileSync(path, readFileSync(path, "utf-8").replace('    - "./skills/level-pacing"', '    - "./skills/level-pacing"\n    - "./skills/not-written-yet"'));
		process.chdir(repo);
		await modelWriting(referenceOf(path));
		await runCompile({ slug: "wright", quiet: true });

		const { data, content } = matter(readFileSync(compiledPathFor(path), "utf-8"));
		expect(data.name).toBe("wright");
		expect(data.skills).toEqual(["level-pacing"]);
		expect(content).toContain("`pacing-notes.md`");
	});

	it("a crossing in session marks the document stale and the model rewrites it, never the template", async () => {
		// The hook `makeCtx` hands the living loop, not a copy of it.
		const repo = join(base, "repo");
		const path = withSkillAndReference(repo, "wright");
		process.chdir(repo);
		ensureState(run.assemble(path).handle);
		const written = "# You are Wright\n\nWritten by the model.\n";
		const compiledPath = compiledPathFor(path);
		mkdirSync(join(repo, ".personaxis", "personas", "wright"), { recursive: true });
		writeFileSync(compiledPath, "stale\n");
		// The model answers with the reference plus a line of its own, so its document passes the check and is
		// told apart from the template the hook used to write.
		await modelWriting(`${referenceOf(path)}\n\n${written}`);

		await recompileHookFor(path, compiledPath)(run.assemble(path).handle);
		expect(readFileSync(compiledPath, "utf-8")).toBe("stale\n"); // the turn does not wait on the model
		for (let i = 0; i < 100 && readRecompilePending(path).pending; i += 1) await new Promise((r) => setTimeout(r, 50));

		expect(readRecompilePending(path).pending).toBe(false);
		expect(readFileSync(compiledPath, "utf-8")).toContain("Written by the model.");
		expect(model!.requests.length).toBeGreaterThan(0);
		// And the version says why it was written.
		expect(compiledHistory(path).at(-1)?.cause).toBe("a band was crossed in a session");
	});

	it("a failed rewrite leaves the mark for the next try", async () => {
		const repo = join(base, "repo");
		const path = withSkillAndReference(repo, "wright");
		process.chdir(repo);
		ensureState(run.assemble(path).handle);
		const compiledPath = compiledPathFor(path);
		writeFileSync(compiledPath, "stale\n");
		await modelWriting("Hello.");
		markRecompilePending(path, "test");

		await recompileHookFor(path, compiledPath)(run.assemble(path).handle);
		for (let i = 0; i < 100 && !existsSync(join(repo, ".personaxis", ".tmp", "rejected-PERSONA.md")); i += 1) await new Promise((r) => setTimeout(r, 50));

		expect(readRecompilePending(path).pending).toBe(true);
		expect(readFileSync(compiledPath, "utf-8")).toBe("stale\n");
	});
});
