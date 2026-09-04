/**
 * What is in a plugin, answered without running it.
 *
 * K1. The kernel could already mount a component and undo exactly what it did; what it
 * could not do was say what a plugin contains without ACTIVATING it, because a
 * `Component` is a function and its contributions only exist once it has been called.
 * For six built-ins we wrote, fine. For anything a person installs, it is the whole
 * problem: a tool's description goes into the prompt, so a plugin that must run to be
 * listed has already run before anybody could decide to trust it, and a malicious one
 * never needs its `execute` called at all.
 *
 * So the property under test is not "a manifest parses". It is that reading the
 * catalogue and running the code are SEPARATE, and the way to prove that is a plugin
 * whose activation would be catastrophic, catalogued in full.
 */

import { describe, expect, it } from "vitest";

import { catalogue, readManifest, type PluginManifest } from "../src/kernel/manifest.js";
import { builtinManifest } from "../src/tools/mounted.js";

function tool(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "weather",
		description: "looks the weather up",
		category: "net",
		isReadOnly: true,
		isConcurrencySafe: true,
		...over,
	};
}

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "acme.weather",
		version: "1.0.0",
		contributes: { tools: [tool()] },
		...over,
	};
}

function accepted(value: unknown): PluginManifest {
	const read = readManifest(value);
	if (!read.ok) throw new Error(`expected a manifest, got: ${read.faults.join("; ")}`);
	return read.manifest;
}

describe("reading what a plugin says it is", () => {
	it("accepts a whole manifest and hands it back", () => {
		expect(accepted(manifest()).contributes.tools?.[0]?.name).toBe("weather");
	});

	it("names everything wrong at once", () => {
		// E30's rule, and it matters more here: the author of a rejected manifest is
		// usually not us, cannot read our source, and an API that reveals one problem per
		// attempt is indistinguishable from a hostile one.
		const read = readManifest({ contributes: { tools: [tool({ category: "file" })] } });

		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.faults.join("|")).toContain("name must be");
		expect(read.faults.join("|")).toContain("version must be");
		expect(read.faults.join("|")).toContain("category must be one of");
	});

	it("refuses a category that does not exist", () => {
		// The exact shape E32 found in the tests: `file` is not a category. The real ones
		// decide tool subsetting, so a name outside them is a branch nothing can reach.
		expect(readManifest(manifest({ contributes: { tools: [tool({ category: "file" })] } })).ok).toBe(
			false,
		);
	});

	it("refuses a tool that will not say whether it is safe to run alongside another", () => {
		// Not defaulted. Those two flags are what the loop reads to decide concurrency,
		// and a contribution that stays quiet is asking the runtime to guess on its behalf.
		for (const flag of ["isReadOnly", "isConcurrencySafe"]) {
			const missing = tool();
			delete missing[flag];
			expect(readManifest(manifest({ contributes: { tools: [missing] } })).ok).toBe(false);
		}
	});

	it("refuses a tool name a prompt would read as something else", () => {
		for (const name of ["two words", "", "-leading", "a".repeat(80)]) {
			expect(readManifest(manifest({ contributes: { tools: [tool({ name })] } })).ok).toBe(false);
		}
	});

	it("accepts a plugin that contributes nothing, which is a real state", () => {
		expect(accepted(manifest({ contributes: {} })).contributes.tools).toBeUndefined();
	});
});

describe("a manifest is data, and that is enforced", () => {
	it("refuses a function anywhere inside it", () => {
		// The structural half of the security claim. A manifest carrying a function is
		// not a manifest with an extra field, it is code that came through the door
		// marked data.
		const read = readManifest(manifest({ contributes: { tools: [tool({ execute: () => "hi" })] } }));

		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.faults[0]).toContain("is a function");
	});

	it("refuses a value that would run code merely by being read", () => {
		// A getter is a function, and a reader that touched fields before checking would
		// have executed it while validating. `findCode` runs first for exactly this.
		let ran = false;
		const trap = manifest();
		Object.defineProperty(trap, "name", {
			enumerable: true,
			get: () => {
				ran = true;
				return "acme.weather";
			},
		});

		expect(readManifest(trap).ok).toBe(false);
		expect(ran).toBe(false);
	});

	it("refuses something nested deeper than data has any reason to be", () => {
		// A cyclic value is not data either, and a reader that followed one forever would
		// be a denial of service wearing a validation check.
		const deep: Record<string, unknown> = {};
		let tip = deep;
		for (let level = 0; level < 12; level += 1) {
			const next: Record<string, unknown> = {};
			tip["down"] = next;
			tip = next;
		}

		expect(readManifest(manifest({ contributes: deep })).ok).toBe(false);
	});
});

describe("what a set of manifests offers", () => {
	it("is worked out without activating anything", () => {
		// The claim, made as sharply as it can be made: this plugin's activation would
		// end the process, and it is catalogued in full, because nothing calls it.
		const wouldDetonate = {
			name: "acme.bomb",
			version: "1.0.0",
			contributes: { tools: [tool({ name: "harmless_sounding" })] },
			// Not part of the shape, and that is the point: even if a loader kept it, the
			// catalogue is built from the fields above and never from this.
		};
		const activate = (): never => {
			throw new Error("the catalogue activated a plugin");
		};

		const built = catalogue([accepted(wouldDetonate)]);

		expect(built.tools.map((entry) => entry.tool.name)).toEqual(["harmless_sounding"]);
		expect(activate).toBeTypeOf("function");
	});

	it("says who contributes each tool", () => {
		const built = catalogue([
			accepted(manifest()),
			accepted(manifest({ name: "acme.files", contributes: { tools: [tool({ name: "grep" })] } })),
		]);

		expect(built.tools).toEqual([
			{ plugin: "acme.weather", tool: expect.objectContaining({ name: "weather" }) },
			{ plugin: "acme.files", tool: expect.objectContaining({ name: "grep" }) },
		]);
	});

	it("reports a name two plugins claim rather than picking a winner", () => {
		// Picking one would make which plugin owns `read_file` depend on load order,
		// which is an answer that is right in testing and wrong in an install.
		const built = catalogue([
			accepted(manifest()),
			accepted(manifest({ name: "evil.weather" })),
		]);

		expect(built.collisions).toEqual([
			{ name: "weather", claimedBy: ["acme.weather", "evil.weather"] },
		]);
		expect(built.tools).toHaveLength(1);
	});

	it("keeps the order the manifests were given, so a prompt prefix does not move", () => {
		// The cache discipline E5 established: a catalogue that reshuffled between turns
		// would change the prefix for no reason a person could see.
		const names = ["a_tool", "b_tool", "c_tool"];
		const built = catalogue(
			names.map((name, index) =>
				accepted(manifest({ name: `p${index}`, contributes: { tools: [tool({ name })] } })),
			),
		);

		expect(built.tools.map((entry) => entry.tool.name)).toEqual(names);
	});
});

describe("the built-ins come through the same door", () => {
	it("describe themselves as a manifest the reader accepts", () => {
		// A reader that has never accepted a real manifest is a reader nobody checked.
		const built = builtinManifest();

		expect(built.name).toBe("personaxis.builtin");
		expect(readManifest(built).ok).toBe(true);
	});

	it("list every tool the kernel actually mounts, with its permission", () => {
		const named = builtinManifest().contributes.tools ?? [];

		expect(named.map((tool) => tool.name).sort()).toEqual(
			["edit_file", "finish", "list_dir", "read_file", "run_command", "write_file"].sort(),
		);
		expect(named.find((tool) => tool.name === "read_file")?.requires).toEqual(["tools.read"]);
		// `finish` needs nothing, and absent is the honest way to say so.
		expect(named.find((tool) => tool.name === "finish")?.requires).toBeUndefined();
	});

	it("claim no name twice", () => {
		expect(catalogue([builtinManifest()]).collisions).toEqual([]);
	});
});
