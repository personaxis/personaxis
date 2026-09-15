/**
 * E98: a tool this package defines is a tool a persona is actually shown.
 *
 * `check_page` was written in `E71`, imported by the built-in barrel, left out of its list, and offered to
 * nobody for four days. Nothing caught it: the catalogue gate counted the same list that was missing it,
 * `designed-not-connected` saw the import and called the export reached, and the bench recorded "did not call
 * check_page" run after run, which read as a choice the model made. The service step written to use it said it
 * would verify "without relying on unavailable tools".
 *
 * So this file asserts the two things nobody was asserting: every tool defined under `builtin/` is in the list
 * the catalogue is built from, and a persona whose permissions allow it is shown that tool by name.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Kernel } from "../src/kernel/index.js";
import { BUILTIN_TOOLS } from "../src/tools/builtin/index.js";
import { grantedPermissions, mountBuiltins, TOOL_PERMISSIONS, type ToolBench } from "../src/tools/mounted.js";
import type { ToolSpec } from "../src/tools/registry.js";

const BUILTIN_DIR = fileURLToPath(new URL("../src/tools/builtin/", import.meta.url));

/** Every tool declared in a file under `builtin/`, read from the directory rather than from the list. */
async function declaredInFiles(): Promise<string[]> {
	const names: string[] = [];
	for (const file of readdirSync(BUILTIN_DIR).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
		const module = (await import(new URL(file, new URL("../src/tools/builtin/", import.meta.url)).href)) as Record<string, unknown>;
		for (const value of Object.values(module)) {
			const tool = value as Partial<ToolSpec>;
			if (typeof tool?.name === "string" && typeof tool.gate === "function" && typeof tool.execute === "function") names.push(tool.name);
		}
	}
	return names.sort();
}

const names = (bench: ToolBench): string[] => bench.tools.map((tool) => tool.name);

describe("a tool this package defines is a tool a persona is shown (E98)", () => {
	it("leaves no tool file out of the list the catalogue is built from", async () => {
		// The check that would have caught it on the day: the directory, not the list, is the source.
		expect(await declaredInFiles()).toEqual(BUILTIN_TOOLS.map((tool) => tool.name).sort());
	});

	it("shows a persona every built-in it has permission for, named one by one", () => {
		const kernel = new Kernel();
		const bench = mountBuiltins(
			kernel,
			grantedPermissions([TOOL_PERMISSIONS.readFiles, TOOL_PERMISSIONS.writeFiles, TOOL_PERMISSIONS.runCommands]),
		);

		// Written out rather than derived from the list, because a test that derives both sides passes on a
		// catalogue missing a tool, which is exactly what happened.
		for (const name of ["run_command", "read_file", "list_dir", "find_in_files", "write_file", "edit_file", "check_page", "finish"]) {
			expect(names(bench)).toContain(name);
		}
	});

	it("shows check_page to a persona that may only read, because running the page it wrote is a read", () => {
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, grantedPermissions([TOOL_PERMISSIONS.readFiles]));

		expect(names(bench)).toContain("check_page");
		expect(names(bench)).not.toContain("write_file");
	});

	it("stops showing it when the permission to read goes", () => {
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, grantedPermissions([]));

		expect(names(bench)).not.toContain("check_page");
	});
});
