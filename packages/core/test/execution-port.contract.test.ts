/**
 * F2: the contract that makes a hosted runner swappable for a laptop.
 *
 * The promise is that the loop cannot tell where it ran, and the desk cannot either except
 * for one line saying where. That promise is only worth something if every implementation
 * agrees on the SHAPES, including the failure shapes: a remote runner whose timeout came
 * back looking different from a local one would make the engine behave differently
 * depending on where it ran, and that shows up as a run that "works locally".
 *
 * These properties are stated once and run over every port there is. The E2B or Daytona
 * adapter, when it exists, joins the array and inherits the whole verification.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	localExecution,
	noExecution,
	type ExecutionPort,
} from "../src/ports/execution.js";
import type { Policy } from "../src/sandbox.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pxs-exec-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function policy(): Policy {
	return { sandbox: "workspace-write", approval: "never", allow: [], deny: [], workspaceRoot: root };
}

/** Every implementation of the port, including the one that refuses everything. */
const PORTS: Array<{ name: string; make: () => ExecutionPort }> = [
	{ name: "local", make: localExecution },
	{ name: "none", make: () => noExecution("no sandbox is up") },
];

describe.each(PORTS)("$name meets the execution contract", ({ make }) => {
	it("says where it runs, in words a person reads", () => {
		const port = make();
		expect(["machine", "hosted"]).toContain(port.location);
		expect(port.describe.length).toBeGreaterThan(0);
	});

	it("returns a command result with every field, however it went", () => {
		// A caller destructuring `stdout` off a result that omitted it on failure gets
		// undefined and prints "undefined" into a record nobody can edit afterwards.
		return make()
			.runCommand("echo hello", policy())
			.then((result) => {
				expect(result).toMatchObject({
					ok: expect.any(Boolean),
					stdout: expect.any(String),
					stderr: expect.any(String),
					truncated: expect.any(Boolean),
					timedOut: expect.any(Boolean),
				});
				expect(result.code === null || typeof result.code === "number").toBe(true);
			});
	});

	it("returns a file result that always names the path it was asked about", async () => {
		// Including on failure. A refusal that does not say which path it refused sends
		// somebody reading a trace back to guess from the command.
		const port = make();
		for (const result of [
			await port.writeFile("out.txt", "x", policy()),
			await port.readFile("out.txt", policy()),
			await port.editFile("out.txt", "x", "y", policy()),
			await port.listDir(".", policy()),
		]) {
			expect(typeof result.ok).toBe("boolean");
			expect(typeof result.path).toBe("string");
		}
	});

	it("never throws, whatever it is handed", async () => {
		// A throw from here escapes into the agent loop, which is the difference between a
		// failed step the model can react to and a run that dies mid-way.
		const port = make();
		for (const path of ["", "../../etc/passwd", "a".repeat(5000)]) {
			await expect(port.readFile(path, policy())).resolves.toBeDefined();
			await expect(port.writeFile(path, "x", policy())).resolves.toBeDefined();
		}
		await expect(port.runCommand("", policy())).resolves.toBeDefined();
	});

	it("is a promise even when the work is synchronous", async () => {
		// The local implementation could have been synchronous, and shaping the port around
		// it would force every caller to be rewritten the day a remote one arrives. That
		// rewrite is the "engine learns something new" this item exists to avoid.
		expect(make().runCommand("echo hi", policy())).toBeInstanceOf(Promise);
	});
});

describe("the local port actually acts", () => {
	it("runs a command and captures its output", async () => {
		const result = await localExecution().runCommand("echo contract", policy());
		expect(result.ok).toBe(true);
		expect(result.stdout).toContain("contract");
	});

	it("writes and reads back through the workspace root", async () => {
		const port = localExecution();
		await port.writeFile("notes/out.txt", "written", policy());

		expect(readFileSync(join(root, "notes", "out.txt"), "utf-8")).toBe("written");
		expect((await port.readFile("notes/out.txt", policy())).content).toBe("written");
	});

	it("edits in place", async () => {
		const port = localExecution();
		writeFileSync(join(root, "edit.txt"), "before");

		await port.editFile("edit.txt", "before", "after", policy());
		expect(readFileSync(join(root, "edit.txt"), "utf-8")).toBe("after");
	});
});

describe("the port that has nowhere to run", () => {
	it("refuses every action rather than falling back to this machine", async () => {
		// The worst thing this file could do is run a hosted job's commands on whatever
		// machine happens to be hosting the process, and the easiest way to get there is a
		// `?? localExecution()` somewhere. This is the test that would fail if it appeared.
		const port = noExecution("no sandbox is up");

		expect((await port.runCommand("echo leaked", policy())).ok).toBe(false);
		expect((await port.writeFile("should-not-exist.txt", "x", policy())).ok).toBe(false);

		// And nothing reached the filesystem.
		expect(() => readFileSync(join(root, "should-not-exist.txt"), "utf-8")).toThrow();
	});

	it("says why, not just no", async () => {
		const result = await noExecution("the sandbox failed to start").runCommand("ls", policy());
		expect(result.stderr).toContain("the sandbox failed to start");
	});

	it("describes itself as having nowhere to run", () => {
		expect(noExecution("quota exhausted").describe).toContain("quota exhausted");
	});
});
