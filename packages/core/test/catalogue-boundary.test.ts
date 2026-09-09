/**
 * A tool arrives at a boundary. A tool leaves the moment it is withdrawn.
 *
 * K5, and the asymmetry is the row rather than a compromise between two half-rules.
 *
 * Tool declarations sit inside the cached prompt prefix. A provider charges 1.25x to
 * write a prefix and 0.1x to read one, and the discount stops at the first token that
 * differs, so a tool appearing mid-session invalidates everything behind it and the whole
 * transcript is re-read. `K2` made that possible by letting a plugin wake in the middle
 * of a session; this is the other half of it. An ADDITION therefore waits for a boundary
 * where the prefix is being rewritten anyway, which is exactly what `E6` named two of.
 *
 * A REMOVAL costs the same prefix and does not wait, because what it buys is not money. A
 * model handed a tool it may not use will use it, be refused, and try again in a slightly
 * different shape, which is the loop the breaker exists to stop, and it spends the turn's
 * budget on calls that were never going to run.
 *
 * ## What this found on the way
 *
 * `PersonaAgent` copied the bench ONCE, in its constructor, and never looked again. So
 * the property `mounted.ts` argues for at length, that a withdrawn permission stops a
 * tool being offered, was true of the bench and false of every running agent, and a
 * plugin woken by K2 could never have reached one.
 */

import { describe, expect, it } from "vitest";

import { Kernel, PERMISSIONS, type PermissionSource } from "../src/kernel/index.js";
import {
	grantedPermissions,
	mountBuiltins,
	TOOL_POINT,
	TOOL_PERMISSIONS,
	type ToolBench,
} from "../src/tools/mounted.js";
import type { ToolSpec } from "../src/tools/registry.js";
import { PersonaAgent } from "../src/agent.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

/** A tool a plugin might contribute later, with the fields a contribution must carry. */
const LATE: ToolSpec = {
	name: "late_arrival",
	description: "arrives after the session started",
	category: "meta",
	isReadOnly: true,
	isConcurrencySafe: true,
	parameters: { type: "object", properties: {} },
	gate: () => ({
		decision: "allow",
		reason: "harmless",
		class: { writesFiles: false, network: false, destructive: false, escapesWorkspace: false },
	}),
	execute: async () => "here",
};

const everything: PermissionSource = { answer: () => ({ granted: true }) };

function names(bench: ToolBench): string[] {
	return bench.tools.map((tool) => tool.name);
}

describe("a tool that arrives after the session started", () => {
	it("is not offered until the catalogue is refreshed", () => {
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, everything);

		kernel.mount({ name: "plugin", activate: (c) => c.contribute(TOOL_POINT, LATE) });

		expect(names(bench)).not.toContain("late_arrival");
	});

	it("is offered from the next boundary on", () => {
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, everything);
		kernel.mount({ name: "plugin", activate: (c) => c.contribute(TOOL_POINT, LATE) });

		const change = bench.refresh();

		expect(names(bench)).toContain("late_arrival");
		expect(change.added).toEqual(["late_arrival"]);
	});

	it("says nothing moved when nothing did, so a boundary is cheap to cross", () => {
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, everything);

		expect(bench.refresh()).toEqual({ added: [], removed: [] });
	});
});

describe("a tool whose permission is withdrawn", () => {
	it("stops being offered immediately, without waiting for a boundary", () => {
		// The half that does not wait. Offering a tool that will be refused is what makes
		// a model try the same thing in five shapes.
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, grantedPermissions([TOOL_PERMISSIONS.readFiles]));
		expect(names(bench)).toContain("read_file");

		kernel.replace(PERMISSIONS, grantedPermissions([]));

		expect(names(bench)).not.toContain("read_file");
	});

	it("is reported as removed by the next refresh, so a caller can say what changed", () => {
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, grantedPermissions([TOOL_PERMISSIONS.readFiles]));

		kernel.replace(PERMISSIONS, grantedPermissions([]));
		const change = bench.refresh();

		expect(change.removed).toContain("read_file");
		expect(change.added).toEqual([]);
	});

	it("comes back the moment the permission does, because the session already knew it", () => {
		// Written the other way round first, expecting a re-grant to wait for a boundary
		// like any other addition, and the test failed. The behaviour is better than the
		// rule I had written, and the rule is now this: BETWEEN BOUNDARIES THE CATALOGUE
		// IS A SUBSET OF THE LAST SNAPSHOT. A name the session has already been shown may
		// leave and come back; a name it has never seen cannot appear. That is the cache
		// claim in its strongest form, and it is stronger than deferring a re-grant would
		// have been: nothing unknown can enter the prefix mid-session either way, and a
		// persona does not lose a tool it may use until the next boundary for no reason.
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, grantedPermissions([TOOL_PERMISSIONS.readFiles]));
		kernel.replace(PERMISSIONS, grantedPermissions([]));
		expect(names(bench)).not.toContain("read_file");

		kernel.replace(PERMISSIONS, grantedPermissions([TOOL_PERMISSIONS.readFiles]));

		expect(names(bench)).toContain("read_file");
	});

	it("never lets a name the session has not seen in, whatever happens between boundaries", () => {
		// The rule above, asserted as the invariant rather than as one example of it.
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, everything);
		const shown = new Set(names(bench));

		kernel.mount({ name: "plugin", activate: (c) => c.contribute(TOOL_POINT, LATE) });
		kernel.replace(PERMISSIONS, grantedPermissions([TOOL_PERMISSIONS.readFiles]));
		kernel.replace(PERMISSIONS, everything);

		for (const name of names(bench)) expect(shown.has(name)).toBe(true);
	});
});

describe("what the catalogue looks like when nobody refreshes", () => {
	it("is everything that was there at mount, so an old caller is unchanged", () => {
		// The behaviour before K5 existed, kept by construction rather than by a flag: a
		// caller that never refreshes sees exactly what it saw.
		const kernel = new Kernel();

		const bench = mountBuiltins(kernel, everything);

		expect(names(bench)).toEqual([
			"read_file",
			"list_dir",
			"find_in_files",
			"write_file",
			"edit_file",
			"run_command",
			"finish",
		]);
	});

	it("keeps the declared order across a refresh, because the prefix depends on it", () => {
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, everything);
		kernel.mount({ name: "plugin", activate: (c) => c.contribute(TOOL_POINT, LATE) });

		bench.refresh();

		expect(names(bench)).toEqual([
			"read_file",
			"list_dir",
			"find_in_files",
			"write_file",
			"edit_file",
			"run_command",
			"finish",
			"late_arrival",
		]);
	});
});

describe("what a running persona is actually offered", () => {
	/** Records the tool names sent with each request, which is what the model sees. */
	function watching(): { llm: { endpoint: string; model: string; fetchImpl: typeof fetch }; offered: string[][] } {
		const offered: string[][] = [];
		return {
			offered,
			llm: {
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: (async (url: string, init: { body: string }) => {
					if (String(url).endsWith("/models")) {
						return { ok: true, status: 200, json: async () => ({ data: [] }) };
					}
					const body = JSON.parse(init.body) as {
						tools?: Array<{ function: { name: string } }>;
					};
					offered.push((body.tools ?? []).map((tool) => tool.function.name));
					return {
						ok: true,
						status: 200,
						json: async () => ({ choices: [{ message: { content: "done" } }] }),
					};
				}) as unknown as typeof fetch,
			},
		};
	}

	it("loses a tool whose permission was withdrawn between turns", async () => {
		// The defect this row uncovered. `PersonaAgent` copied the bench once, in its
		// constructor, and never looked again, so the property `mounted.ts` argues for at
		// length was true of the bench and false of every running agent.
		const kernel = new Kernel();
		const { llm, offered } = watching();
		const agent = new PersonaAgent({
			llm,
			kernel,
			policy: { ...DEFAULT_POLICY, workspaceRoot: process.cwd() },
			personaBody: "You are a tester.",
			maxSteps: 1,
		});

		await agent.run("first");
		expect(offered[0]).toContain("run_command");

		kernel.replace(PERMISSIONS, grantedPermissions([TOOL_PERMISSIONS.readFiles]));
		await agent.run("second");

		expect(offered[1]).not.toContain("run_command");
		expect(offered[1]).toContain("read_file");
	});

	it("gains a tool a plugin contributed, at the start of the next turn and not inside one", async () => {
		const kernel = new Kernel();
		const { llm, offered } = watching();
		const agent = new PersonaAgent({
			llm,
			kernel,
			policy: { ...DEFAULT_POLICY, workspaceRoot: process.cwd() },
			personaBody: "You are a tester.",
			maxSteps: 1,
		});
		await agent.run("first");
		expect(offered[0]).not.toContain("late_arrival");

		kernel.mount({ name: "plugin", activate: (c) => c.contribute(TOOL_POINT, LATE) });
		await agent.run("second");

		expect(offered[1]).toContain("late_arrival");
	});
});
