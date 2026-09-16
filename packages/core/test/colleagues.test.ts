/**
 * E87: who a colleague is, and what it may do when work reaches it.
 *
 * O22, decided by David on 2026-09-15: the lower ceiling of the two. These pin both axes the gate reads,
 * because crossing only the sandbox would be decorative: `evaluateCommand` answers `allow` to a risky
 * operation under `never` or `on-failure`, so a looser colleague would turn into silent permission exactly
 * what the asker would have put in front of a person.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { colleaguePathFor, colleaguesOf, lowerCeiling } from "../src/run/colleagues.js";
import type { SandboxMode } from "../src/sandbox.js";

let dir: string;
let personaPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e87-"));
	personaPath = join(dir, ".personaxis", "personaxis.md");
	mkdirSync(join(dir, ".personaxis"), { recursive: true });
	writeFileSync(personaPath, "---\nidentity:\n  system_identity:\n    purpose: runs the shop\n---\n# Boss\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A sub-persona on disk at `address`, with the purpose its own spec declares. */
function subPersona(address: string, purpose: string): void {
	const folder = join(dir, ".personaxis", "personas", ...address.split("/").join("/personas/").split("/"));
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "personaxis.md"), `---\nidentity:\n  system_identity:\n    purpose: ${purpose}\n---\n# ${address}\n`);
}

describe("the lower ceiling of the two (E87, O22)", () => {
	it("takes the stricter sandbox, whichever side it came from", () => {
		// Through the ceiling and not through the comparison behind it: the comparison is internal, because an
		// export nothing outside its module reaches is one the `designed-not-connected` sweep counts, and a test
		// reaching in would be proving the code runs rather than that anything uses it.
		const sandboxOf = (asking: SandboxMode, colleague: SandboxMode): SandboxMode =>
			lowerCeiling({ sandbox: asking, approval: "on-request" }, { sandbox: colleague, approval: "on-request" }).sandbox;

		expect(sandboxOf("workspace-write", "read-only")).toBe("read-only");
		expect(sandboxOf("read-only", "workspace-write")).toBe("read-only");
		expect(sandboxOf("danger-full-access", "workspace-write")).toBe("workspace-write");
		expect(sandboxOf("read-only", "read-only")).toBe("read-only");
	});

	it("does not let a looser colleague widen either axis", () => {
		const under = lowerCeiling({ sandbox: "workspace-write", approval: "on-request" }, { sandbox: "danger-full-access", approval: "never" });

		expect(under).toEqual({ sandbox: "workspace-write", approval: "on-request" });
	});

	it("does not let a looser asker widen the colleague's own limits either", () => {
		// Least privilege reads the same in both directions: the ceiling is the lower one, not the caller's.
		const under = lowerCeiling({ sandbox: "danger-full-access", approval: "never" }, { sandbox: "read-only", approval: "untrusted" });

		expect(under).toEqual({ sandbox: "read-only", approval: "untrusted" });
	});

	it("keeps the approval axis, which is the one that decides whether a risky call runs at all", () => {
		// Under `never` a risky operation comes back allowed, and a delegated child never asks anybody, so
		// this is not about who is prompted: it is about whether the work happens unasked.
		expect(lowerCeiling({ sandbox: "read-only", approval: "on-request" }, { approval: "never" }).approval).toBe("on-request");
	});

	it("reads what a colleague did not declare as the asker's, because absence is not a declaration", () => {
		const under = lowerCeiling({ sandbox: "workspace-write", approval: "on-request" }, {});

		expect(under).toEqual({ sandbox: "workspace-write", approval: "on-request" });
	});
});

describe("finding a colleague by the address the map shows (E87)", () => {
	it("resolves one level and several, the way the map writes them", () => {
		expect(colleaguePathFor(personaPath, "cmo")).toBe(join(dir, ".personaxis", "personas", "cmo", "personaxis.md"));
		expect(colleaguePathFor(personaPath, "cmo/legal")).toBe(
			join(dir, ".personaxis", "personas", "cmo", "personas", "legal", "personaxis.md"),
		);
	});

	it("takes the address as the map prints it, with the at sign", () => {
		expect(colleaguePathFor(personaPath, "@cmo")).toBe(colleaguePathFor(personaPath, "cmo"));
	});

	it("refuses anything that is a path rather than a name, so traversal never becomes a folder", () => {
		for (const bad of ["..", "cmo/..", "", "   ", "c:/tmp", "cmo\\legal", "cmo//legal"]) {
			expect(colleaguePathFor(personaPath, bad)).toBeUndefined();
		}
	});

	it("lists the colleagues the map lists, with the purpose each one declares", () => {
		subPersona("cmo", "writes the campaigns");
		subPersona("cmo/legal", "checks the wording");

		expect(colleaguesOf(personaPath)).toEqual([
			{ name: "cmo", about: "writes the campaigns" },
			{ name: "cmo/legal", about: "checks the wording" },
		]);
	});

	it("says a persona with no sub-personas has no colleagues, rather than failing", () => {
		expect(colleaguesOf(personaPath)).toEqual([]);
	});
});
