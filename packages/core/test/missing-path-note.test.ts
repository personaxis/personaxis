/**
 * A path that is not there answers with what is, instead of telling the persona to stop.
 *
 * E31. Measured against a real model over twenty runs, this branch fired eight times and
 * the persona abandoned the task in seven of them: one `list_dir`, one call, and "I'm
 * sorry, I can't find the config file" with the file sitting in `src/`. It was the
 * dominant cause of failure in both banks of E28.
 *
 * The obvious fix was tried and discarded. Swapping `Continue with what you have.` for a
 * sentence that opens a next step instead of closing one recovered 1 of 4 against 0 of
 * 4, which at that n is noise. So this is not another sentence: it is the next step,
 * taken. The runtime can list the neighbouring directory without asking the model for
 * anything, and a name in front of a model is not the same kind of thing as a suggestion
 * that it go looking.
 *
 * What these fix in place is the shape of that answer, because two properties are easy to
 * lose. It stays a `note:` and never becomes an `error:`, which is V3.1 and load-bearing:
 * an error zeroed step progress and could abort a whole run over one optional read. And
 * the listing is bounded, because a truncated list that does not say it is truncated
 * invites exactly the wrong conclusion.
 */

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localExecution } from "../src/ports/execution.js";
import { listDirTool } from "../src/tools/builtin/list-dir.js";
import { readFileTool } from "../src/tools/builtin/read-file.js";
import type { Policy } from "../src/sandbox.js";

/** A policy over one root. Whole, because a stub with the wrong shape is E30's lesson. */
function policyOver(workspaceRoot: string): Policy {
	return {
		sandbox: "workspace-write",
		approval: "never",
		allow: [],
		deny: [],
		workspaceRoot,
	};
}

/** A workspace with a file one level down, which is the shape the measurement found. */
function workspace(): { root: string; policy: Policy } {
	const root = mkdtempSync(join(tmpdir(), "pxs-e31-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "config.ts"), "export const a = 1;\n");
	writeFileSync(join(root, "src", "index.ts"), "export * from './config.js';\n");
	writeFileSync(join(root, "README.md"), "# a workspace\n");
	return { root, policy: policyOver(root) };
}

const execution = localExecution();

describe("reading a file that is not there", () => {
	it("hands over the names beside it", async () => {
		// The exact case the model failed on: the file exists, one directory along, and
		// the persona had to guess that. Now it does not have to.
		const { root, policy } = workspace();

		const said = await readFileTool.execute({ path: "src/confg.ts" }, policy, execution);

		expect(said).toContain("does not exist");
		expect(said).toContain("config.ts");
		expect(said).toContain("index.ts");
	});

	it("never tells the persona to continue with what it has", async () => {
		// The sentence the measurement caught. It is gone, and it does not come back as a
		// gentler one: this file's whole finding is that sentences did not move the
		// number and content did.
		const { root, policy } = workspace();

		const said = await readFileTool.execute({ path: "src/confg.ts" }, policy, execution);

		expect(said).not.toContain("Continue with what you have");
	});

	it("stays a note, because an error here can abort a whole run", async () => {
		// V3.1, and it is the one property that must survive every rewrite of this branch.
		const { root, policy } = workspace();

		const said = await readFileTool.execute({ path: "src/confg.ts" }, policy, execution);

		expect(said.startsWith("note:")).toBe(true);
		expect(said).not.toContain("error:");
	});

	it("still reports a real failure as a failure", async () => {
		// The mirror image, and it needed a real failure rather than a path that is
		// merely outside: `../../../etc/passwd` does not EXIST on this machine, so it is
		// a missing file and the note is the right answer. Reading a directory as a file
		// is a failure the filesystem itself names, which is what this needs.
		const { policy } = workspace();

		const said = await readFileTool.execute({ path: "src" }, policy, execution);

		expect(said.startsWith("error:")).toBe(true);
	});

	it("says nothing about anywhere outside the workspace", async () => {
		// The property the walk could have broken, and nearly did: the gate approved the
		// path the caller asked for, and the walk looks at its PARENT, which the gate
		// never saw. A negative control caught it climbing out of an empty workspace and
		// listing twenty thousand entries of the machine's temp directory.
		const { root, policy } = workspace();

		const said = await readFileTool.execute({ path: "../absent.ts" }, policy, execution);

		expect(said).toContain("does not exist");
		expect(said).not.toContain("contains:");
		expect(said).not.toContain(root);
	});
});

describe("listing a directory that is not there", () => {
	it("walks up to the nearest one that is, and lists that", async () => {
		const { policy } = workspace();

		const said = await listDirTool.execute({ path: "src/deep/deeper" }, policy, execution);

		expect(said).toContain("does not exist");
		expect(said).toContain("config.ts");
	});

	it("gives up walking rather than answering with the whole machine", async () => {
		// Three levels, because the useful case is a wrong name or a directory that
		// moved. A walk to the root answers a question nobody asked.
		const { policy } = workspace();

		const said = await listDirTool.execute(
			{ path: "a/b/c/d/e/f/g/h" },
			policy,
			execution,
		);

		expect(said).toContain("does not exist");
		expect(said).not.toContain("README.md");
	});

	it("says a bare note when there is nothing nearby to say", async () => {
		// Empty rather than prose about the emptiness, and still not an instruction to
		// stop. A bare fact is not a suggestion to give up.
		const root = mkdtempSync(join(tmpdir(), "pxs-e31-empty-"));
		const policy = policyOver(root);

		const said = await listDirTool.execute({ path: "nowhere" }, policy, execution);

		expect(said).toContain("does not exist");
		expect(said).not.toContain("contains:");
		expect(said).not.toContain("Continue with what you have");
	});
});

describe("how much it is allowed to say", () => {
	it("caps the listing and says how much it left out", async () => {
		// `node_modules` exists. A listing that floods the window is the same failure as
		// no listing, arriving from the other side.
		const root = mkdtempSync(join(tmpdir(), "pxs-e31-many-"));
		mkdirSync(join(root, "many"));
		for (let index = 0; index < 60; index += 1) {
			writeFileSync(join(root, "many", `file-${index}.ts`), "");
		}
		const policy = policyOver(root);

		const said = await readFileTool.execute({ path: "many/absent.ts" }, policy, execution);

		expect(said).toContain("and 20 more");
		expect(said.split("\n").length).toBeLessThan(50);
	});

	it("does not widen what a persona may see", async () => {
		// The one thing this could have got wrong. The gate approved the path that was
		// asked for and this looks at its PARENT, which the gate never saw. It is safe
		// because the PORT resolves through the policy: a parent outside the sandbox
		// comes back as an error and contributes nothing.
		const outside = mkdtempSync(join(tmpdir(), "pxs-e31-outside-"));
		writeFileSync(join(outside, "secret.env"), "TOKEN=1\n");
		const root = mkdtempSync(join(tmpdir(), "pxs-e31-inside-"));
		const policy = { ...policyOver(root), sandbox: "read-only" as const };

		const said = await readFileTool.execute({ path: "../absent.ts" }, policy, execution);

		expect(said).not.toContain("secret.env");
	});
});
