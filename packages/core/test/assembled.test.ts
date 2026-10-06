/**
 * Where a persona's compiled document lives, and what happens when it is not there.
 *
 * This exists because the answer had two owners and one of them was wrong in the most
 * common layout there is. The CLI knew a root persona's compiled document sits one
 * level ABOVE `.personaxis/`; the SDK looked for it beside the spec, never found it,
 * and fell back to the raw body under a method documented as returning the compiled
 * identity. No error, no warning, just a shorter answer.
 *
 * So the layouts are pinned here, and so is the thing that hid it: the fallback is a
 * separate function with the word in its name, and the field it falls back from says
 * `undefined` rather than quietly saying something else.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assemble, compiledPathFor, identityOf, isSubagentPath } from "../src/run/assembled.js";

const SPEC = `---
apiVersion: persona.dev/v1
metadata: { name: asm, version: 1.0.0 }
identity: { canonical_id: asm }
improvement_policy: { mode: locked }
---
the spec body, which is not the compiled document
`;

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pxs-asm-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A project laid out the way `personaxis init` lays one out. */
function project(): string {
	const dir = join(root, ".personaxis");
	mkdirSync(dir, { recursive: true });
	const spec = join(dir, "personaxis.md");
	writeFileSync(spec, SPEC);
	return spec;
}

/** A sub-persona, whose compiled document lives beside its spec instead. */
function subPersona(): string {
	const dir = join(root, ".personaxis", "personas", "cmo");
	mkdirSync(dir, { recursive: true });
	const spec = join(dir, "personaxis.md");
	writeFileSync(spec, SPEC);
	return spec;
}

describe("where the compiled document belongs", () => {
	it("puts a root persona's one level above .personaxis, at the project root", () => {
		// The case that was wrong. Looking beside the spec finds nothing here, and
		// nothing is exactly what the broken version found.
		const spec = project();

		expect(compiledPathFor(spec)).toBe(join(root, "PERSONA.md"));
		expect(compiledPathFor(spec)).not.toBe(join(dirname(spec), "PERSONA.md"));
	});

	it("puts a sub-persona's beside its own spec", () => {
		const spec = subPersona();

		expect(compiledPathFor(spec)).toBe(join(dirname(spec), "PERSONA.md"));
	});

	it("keeps a persona in the home directory out of the home directory", () => {
		// A documented assumption rather than a spec rule: a home directory is not a
		// project root, so a loose `~/PERSONA.md` would be litter nobody connects to
		// anything.
		const spec = join(homedir(), ".personaxis", "personaxis.md");

		expect(compiledPathFor(spec)).toBe(join(homedir(), ".personaxis", "PERSONA.md"));
	});

	it("recognises a sub-persona by its path on either kind of separator", () => {
		expect(isSubagentPath("/a/.personaxis/personas/cmo/personaxis.md")).toBe(true);
		expect(isSubagentPath("C:\\a\\.personaxis\\personas\\cmo\\personaxis.md")).toBe(true);
		expect(isSubagentPath("/a/.personaxis/personaxis.md")).toBe(false);
	});
});

describe("reading a persona", () => {
	it("finds the compiled document where it actually is", () => {
		const spec = project();
		writeFileSync(join(root, "PERSONA.md"), "# You are Asm\n\nthe compiled document\n");

		const persona = assemble(spec);

		expect(persona.compiled).toContain("the compiled document");
		expect(identityOf(persona)).toContain("the compiled document");
	});

	it("says undefined when it has not been compiled, instead of something shorter", () => {
		// The silence is the bug, not the fallback. A caller asking for the compiled
		// document and receiving the body had no way to tell the two apart.
		const persona = assemble(project());

		expect(persona.compiled).toBeUndefined();
		expect(persona.compiledPath).toBe(join(root, "PERSONA.md"));
	});

	it("still answers with the body when asked for an identity, and says so in the name", () => {
		// A persona that has never been compiled still has to be able to answer, and
		// its spec body is the best description available. What was wrong was doing
		// that under a name that promised the compiled document.
		const persona = assemble(project());

		expect(identityOf(persona)).toContain("the spec body");
	});

	it("leaves a state file behind, so nobody has to remember to", () => {
		// Every caller called `ensureState`. A persona without one is not a persona in
		// a different mode, it is one whose first mutation fails.
		const persona = assemble(project());

		expect(persona.handle.statePath).toBeDefined();
	});
});
