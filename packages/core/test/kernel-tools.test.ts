/**
 * The kernel holding the tools, which is what M4 promised and did not deliver.
 *
 * 1,325 lines of finished kernel whose only callers were an error helper and a bridge.
 * The row that promised this produced `assemble()`, which does not use it. So the
 * question this file answers is not "does the kernel work" (its own tests cover that)
 * but "does anything depend on it", and the answer has to be visible in the product.
 *
 * ## The behaviour, and why it is not cosmetic
 *
 * A tool whose permission is withheld is NOT OFFERED, rather than offered and then
 * refused. A model handed a tool it may not use will use it, be refused, and try again
 * in a slightly different shape, which is the loop the breaker exists to stop. It also
 * spends the turn's budget on calls that were never going to run and fills the
 * transcript with refusals that read like the persona failing.
 *
 * The gate does not move. A tool that IS offered still meets both axes on every call.
 */

import { describe, expect, it } from "vitest";

import { Kernel, permissionKey } from "../src/kernel/index.js";
import {
	ALL_TOOL_PERMISSIONS,
	TOOL_PERMISSIONS,
	grantedPermissions,
	mountBuiltins,
	permissionsFor,
} from "../src/tools/mounted.js";
import { DEFAULT_POLICY, PersonaAgent, TOOLS, run } from "../src/index.js";

const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name).sort();

describe("what a bench offers", () => {
	it("offers every built-in when everything is granted", () => {
		const bench = mountBuiltins(new Kernel(), grantedPermissions(ALL_TOOL_PERMISSIONS));

		expect(names(bench.tools)).toEqual(names(TOOLS));
	});

	it("drops the writers when writing is withheld, and keeps the readers", () => {
		// The granularity that makes this usable. Withholding writes must not cost the
		// persona its ability to look at anything, or the only sensible configuration is
		// all-or-nothing.
		const bench = mountBuiltins(
			new Kernel(),
			grantedPermissions([TOOL_PERMISSIONS.readFiles, TOOL_PERMISSIONS.runCommands]),
		);

		expect(names(bench.tools)).toContain("read_file");
		expect(names(bench.tools)).toContain("list_dir");
		expect(names(bench.tools)).not.toContain("write_file");
		expect(names(bench.tools)).not.toContain("edit_file");
	});

	it("always keeps `finish`, whatever is withheld", () => {
		// A persona that cannot say it is done is a persona that cannot stop, and no
		// operator wants to withhold that. It declares no permission at all.
		const bench = mountBuiltins(new Kernel(), grantedPermissions([]));

		expect(names(bench.tools)).toEqual(["finish"]);
	});

	it("comes back in the declared order, which is the order the prompt sees", () => {
		// The prompt prefix is part of the cache, so a catalogue that reshuffled between
		// turns would change the prefix for no reason a person could see.
		//
		// Worth being honest about what this does and does not prove today. Activation
		// is synchronous, so the declared order and the activation order are the same
		// sequence, and no mutation can separate them: swapping the implementation to
		// return activation order passes this test. It becomes a real distinction the
		// day a permission arrives late, and the assertion is here so that day has
		// something to fail against.
		const bench = mountBuiltins(new Kernel(), grantedPermissions(ALL_TOOL_PERMISSIONS));

		expect(bench.tools.map((tool) => tool.name)).toEqual([
			"read_file",
			"list_dir",
			"write_file",
			"edit_file",
			"run_command",
			"finish",
		]);
	});

	it("empties itself when closed, unwinding every component scope", () => {
		// Withdrawal happens by unwinding a scope, with no removal code anywhere. That
		// is `EffectScope` doing the job it was written for, and this is the assertion
		// that it actually does it.
		const bench = mountBuiltins(new Kernel(), grantedPermissions(ALL_TOOL_PERMISSIONS));
		expect(bench.tools.length).toBeGreaterThan(0);

		bench.close();
		expect(bench.tools).toEqual([]);
	});

	it("says which permission was missing, rather than just refusing", () => {
		// "Denied" with no reason is what makes people turn enforcement off, and a
		// source that could not name the permission would be one of those.
		const source = grantedPermissions([]);
		const answer = source.answer(permissionKey("tools.write"));

		expect(answer.granted).toBe(false);
		expect(answer.granted === false && answer.reason).toContain("tools.write");
	});
});

describe("what a persona's declared posture grants", () => {
	it("gives a read-only persona nothing that writes", () => {
		// The persona already declared a posture, so nobody should have to write the
		// same intent twice as a list of permissions. Read-only means read-only.
		const granted = permissionsFor("read-only").map((permission) => permission.id);

		expect(granted).toEqual(["tools.read"]);
	});

	it("gives a workspace-write persona commands as well as writes", () => {
		// The one line worth arguing about. `workspace-write` means "work in this
		// repository", and working in a repository is running its tests. A persona that
		// can edit code and cannot check it is not safer, it is a persona that guesses.
		const granted = permissionsFor("workspace-write").map((permission) => permission.id);

		expect(granted).toContain("tools.command");
		expect(granted).toContain("tools.write");
	});

	it("gives full access everything", () => {
		expect(permissionsFor("danger-full-access")).toEqual(ALL_TOOL_PERMISSIONS);
	});

	it("reaches the loop through `agentOptionsFor`, not through the caller", () => {
		// Derived beside the budget and the compiled policy, for the reason that file
		// gives: a caller that could pass this would be changing the persona without
		// editing it.
		const options = run.agentOptionsFor({
			personaPath: "/nowhere/PERSONA.md",
			frontmatter: { permissions: { sandbox: "read-only" } },
			llm: { endpoint: "http://x/v1", model: "m" },
		});

		expect(options.permissions?.map((permission) => permission.id)).toEqual(["tools.read"]);
	});
});

describe("the loop, which is where it has to show", () => {
	function toolsOffered(permissions?: readonly ReturnType<typeof permissionKey>[]) {
		const agent = new PersonaAgent({
			llm: { endpoint: "http://x/v1", model: "m" },
			policy: DEFAULT_POLICY,
			...(permissions ? { permissions } : {}),
		});
		return (agent as unknown as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
	}

	it("offers everything when the persona declared no permissions", () => {
		// Absent means every built-in, which is what every caller got before this
		// existed. Withholding is a decision somebody makes, not a default they fall
		// into.
		expect(toolsOffered()).toEqual(TOOLS.map((tool) => tool.name));
	});

	it("does not offer a tool whose permission the persona lacks", () => {
		// The whole point, in the place a model would see it.
		const offered = toolsOffered([TOOL_PERMISSIONS.readFiles]);

		expect(offered).toContain("read_file");
		expect(offered).not.toContain("run_command");
		expect(offered).not.toContain("write_file");
	});

	it("still offers `finish` to a persona granted nothing", () => {
		expect(toolsOffered([])).toEqual(["finish"]);
	});
});
