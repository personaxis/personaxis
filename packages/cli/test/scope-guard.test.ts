// The consented scope, enforced on the way out.
//
// The failure this prevents is not a refused tool call: it is a path reaching a
// preview without any call being refused. A model quotes a filename, a library
// error names a config it could not open, a stack trace carries the whole
// source tree. None is a policy violation and all of them put the operator's
// filesystem layout into a record nobody can edit afterwards.

import { describe, expect, it } from "vitest";

import { guardDeep, guardPaths, OUT_OF_SCOPE, withinScope } from "../src/workspace/scope-guard.js";

const SCOPE = process.platform === "win32" ? ["C:\\work\\acme"] : ["/home/ana/work/acme"];
const inside = process.platform === "win32" ? "C:\\work\\acme\\src\\index.ts" : "/home/ana/work/acme/src/index.ts";
const outside = process.platform === "win32" ? "C:\\Users\\ana\\.ssh\\id_rsa" : "/home/ana/.ssh/id_rsa";

describe("what the workspace may see", () => {
	it("keeps a path inside the consented scope", () => {
		// Naming a directory is what makes it visible. A trace that redacted the
		// file a persona just edited would be unreadable to the person who asked
		// for the edit.
		expect(guardPaths(`edited ${inside}`, SCOPE)).toContain(inside);
	});

	it("redacts a path outside it", () => {
		const out = guardPaths(`could not read ${outside}`, SCOPE);
		expect(out).not.toContain(".ssh");
		expect(out).toContain(OUT_OF_SCOPE);
	});

	it("keeps the sentence around the redaction", () => {
		// The event still has to say what happened.
		const out = guardPaths(`could not read ${outside}`, SCOPE);
		expect(out).toContain("could not read");
	});

	it("redacts everything absolute when nothing was consented to", () => {
		// Same direction as connect: empty means empty rather than defaulting to
		// a home directory.
		expect(guardPaths(`edited ${inside}`, [])).toContain(OUT_OF_SCOPE);
	});
});

describe("the boundary is a separator, not a prefix", () => {
	it("does not admit a sibling directory that shares a prefix", () => {
		// The classic way a scope check turns out never to have been one.
		const sibling =
			process.platform === "win32" ? "C:\\work\\acme-secrets\\keys.txt" : "/home/ana/work/acme-secrets/keys.txt";
		expect(withinScope(sibling, SCOPE)).toBe(false);
		expect(guardPaths(sibling, SCOPE)).toContain(OUT_OF_SCOPE);
	});

	it("admits the scope directory itself", () => {
		expect(withinScope(SCOPE[0], SCOPE)).toBe(true);
	});

	it("admits a nested path", () => {
		expect(withinScope(inside, SCOPE)).toBe(true);
	});

	it("does not admit a traversal out of the scope", () => {
		const escape = `${SCOPE[0]}${process.platform === "win32" ? "\\" : "/"}../../.ssh/id_rsa`;
		expect(withinScope(escape, SCOPE)).toBe(false);
	});
});

describe("leaving prose alone", () => {
	it.each([
		"read 34 files and wrote 2",
		"the ratio is 3/4",
		"see docs/commands/connect.md",
		"https://api.example.com/status",
	])("does not touch %s", (text) => {
		// Relative paths and URLs are not filesystem layout. Redacting them would
		// make every trace unreadable and teach people to ignore the placeholder.
		expect(guardPaths(text, SCOPE)).toBe(text);
	});

	it("does not swallow the punctuation after a path", () => {
		const out = guardPaths(`could not open ${outside}.`, SCOPE);
		expect(out.endsWith(".")).toBe(true);
	});

	it("returns an empty string unchanged", () => {
		expect(guardPaths("", SCOPE)).toBe("");
	});
});

describe("structures", () => {
	it("walks into nested values", () => {
		const out = guardDeep({ error: { path: outside, code: "EACCES" } }, SCOPE) as {
			error: { path: string; code: string };
		};
		expect(out.error.path).toContain(OUT_OF_SCOPE);
		expect(out.error.code).toBe("EACCES");
	});

	it("walks arrays", () => {
		const out = guardDeep([inside, outside], SCOPE) as string[];
		expect(out[0]).toContain("acme");
		expect(out[1]).toContain(OUT_OF_SCOPE);
	});

	it("leaves non-strings alone", () => {
		expect(guardDeep({ count: 3, ok: true }, SCOPE)).toEqual({ count: 3, ok: true });
	});

	it("does not hang on a cyclic structure", () => {
		const cyclic: Record<string, unknown> = { path: outside };
		cyclic.self = cyclic;
		expect(() => guardDeep(cyclic, SCOPE)).not.toThrow();
	});
});

describe("case sensitivity, where the platform has an opinion", () => {
	it("matches the operator's own directory whatever they typed", () => {
		// Windows and macOS compare paths case-insensitively. A scope of C:\Work
		// that refused C:\work would redact the operator's own files.
		const shouted = SCOPE[0].toUpperCase();
		const expected = process.platform === "win32" || process.platform === "darwin";
		expect(withinScope(`${shouted}${process.platform === "win32" ? "\\" : "/"}a.ts`, SCOPE)).toBe(expected);
	});
});
