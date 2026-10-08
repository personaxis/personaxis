/**
 * Every written version of PERSONA.md is in the persona's record, with why and from what, and its text is
 * kept once per hash. Since 2026-10-07 a model writes the document, so two compiles of one definition are
 * two documents and the definition alone cannot say which one an agent read.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compiledHistory, ensureState, loadPersona, recordCompiled } from "../src/index.js";

const PERSONA = `---
apiVersion: personaxis.com/v1
kind: AgentPersona
spec_version: "1.1.0"
metadata: { name: tester, version: 1.0.0, description: test, created: "2026-10-07" }
identity: { canonical_id: tester, display_name: Tester, system_identity: { purpose: test }, role_identity: { primary_role: tester, relationship_to_user: tester } }
improvement_policy: { mode: suggesting }
---
body
`;

let dir = "";
let personaPath = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-compiled-history-"));
	personaPath = join(dir, "personaxis.md");
	writeFileSync(personaPath, PERSONA);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the compiled history", () => {
	it("records each version with its cause, definition and model, and keeps its text once per hash", async () => {
		const handle = loadPersona(personaPath);
		ensureState(handle);
		const first = await recordCompiled(personaPath, handle.statePath, { document: "# You are Tester\n\nOne.\n", specText: PERSONA, cause: "creation", model: "m1" });
		await recordCompiled(personaPath, handle.statePath, { document: "# You are Tester\n\nTwo.\n", specText: PERSONA, cause: "a band was crossed in a session", model: "m1" });
		await recordCompiled(personaPath, handle.statePath, { document: "# You are Tester\n\nOne.\n", specText: PERSONA, cause: "compile", model: "m2" });

		const versions = compiledHistory(personaPath);
		expect(versions.map((v) => v.cause)).toEqual(["creation", "a band was crossed in a session", "compile"]);
		expect(versions[0]!.hash).toBe(versions[2]!.hash);
		expect(versions[0]!.spec).toBe(versions[1]!.spec);
		expect(versions.map((v) => v.model)).toEqual(["m1", "m1", "m2"]);
		expect(readdirSync(join(dir, "compiled"))).toHaveLength(2);
		expect(readFileSync(versions[0]!.path!, "utf-8")).toBe("# You are Tester\n\nOne.\n");
		expect(versions[0]!.hash).toBe(first.hash);
	});

	it("is empty for a persona never compiled, and says when a version's text was not kept", async () => {
		expect(compiledHistory(personaPath)).toEqual([]);
		const handle = loadPersona(personaPath);
		ensureState(handle);
		const v = await recordCompiled(personaPath, handle.statePath, { document: "x\n", specText: PERSONA, cause: "compile", model: "m" });
		rmSync(v.path!);
		expect(existsSync(v.path!)).toBe(false);
		expect(compiledHistory(personaPath)[0]!.path).toBeUndefined();
	});
});
