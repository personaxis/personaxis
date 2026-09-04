/**
 * A capability arrives, and the core does not grow a line.
 *
 * K3. `tools/mounted.ts` used to hold a `Set` and a closure it passed down to each
 * component, which is an extension point written by hand for one caller. The dependency
 * pointed the wrong way: the module that ASSEMBLES tools imported every tool there is,
 * so the thing that should be stable imported the things that keep arriving.
 *
 * A point inverts it. The consumer declares it, the contributor fills it, and neither
 * imports the other: both import a declaration that is a name and a type. What these
 * fix in place is the part that is easy to lose in a refactor: a contribution lives
 * exactly as long as the component that made it, and the order is the order things were
 * contributed, because the tool catalogue is part of the prompt prefix.
 */

import { describe, expect, it } from "vitest";

import {
	Kernel,
	extensionPoint,
	permissionKey,
	serviceKey,
	PERMISSIONS,
	type PermissionSource,
} from "../src/kernel/index.js";
import { grantedPermissions, mountBuiltins, TOOL_POINT } from "../src/tools/mounted.js";
import { TOOL_PERMISSIONS } from "../src/tools/mounted.js";

const GREETING = extensionPoint<string>("greetings");
const CLOCK = serviceKey<() => number>("clock");
const MAY_GREET = permissionKey("greet");

/** Every permission granted, which is the uninteresting case these tests vary from. */
const everything: PermissionSource = { answer: () => ({ granted: true }) };

describe("a point somebody else declared", () => {
	it("is empty until something plugs in, which is a real answer", () => {
		// A host that offers a place to plug in and has nothing plugged in is working
		// correctly, not missing something.
		expect(new Kernel().extensions.of(GREETING)).toEqual([]);
	});

	it("collects what components contribute, without either knowing the other", () => {
		const kernel = new Kernel();

		kernel.mount({ name: "english", activate: (c) => c.contribute(GREETING, "hello") });
		kernel.mount({ name: "spanish", activate: (c) => c.contribute(GREETING, "hola") });

		expect(kernel.extensions.of(GREETING)).toEqual(["hello", "hola"]);
	});

	it("keeps the order things arrived in, because a prompt prefix depends on it", () => {
		// E5's cache discipline read from the other side: a registry that reshuffled
		// itself between turns would move the prefix, and every token after it would be
		// re-read by the provider.
		const kernel = new Kernel();
		const words = ["one", "two", "three", "four"];

		for (const word of words) {
			kernel.mount({ name: word, activate: (c) => c.contribute(GREETING, word) });
		}

		expect(kernel.extensions.of(GREETING)).toEqual(words);
	});

	it("lets one component contribute more than once", () => {
		const kernel = new Kernel();

		kernel.mount({
			name: "polyglot",
			activate: (c) => {
				c.contribute(GREETING, "hello");
				c.contribute(GREETING, "hola");
			},
		});

		expect(kernel.extensions.of(GREETING)).toEqual(["hello", "hola"]);
	});
});

describe("a contribution lives exactly as long as its component", () => {
	it("goes when the component unmounts", () => {
		const kernel = new Kernel();
		const unmount = kernel.mount({
			name: "english",
			activate: (c) => c.contribute(GREETING, "hello"),
		});

		unmount();

		expect(kernel.extensions.of(GREETING)).toEqual([]);
	});

	it("goes when the permission it needed is withdrawn, rather than staying to be refused", () => {
		// The property this is for. A withdrawn permission has to REMOVE the capability
		// from the catalogue: a model handed a tool it may not use will use it, be
		// refused, and try again in a slightly different shape, which is the loop the
		// breaker exists to stop.
		const kernel = new Kernel();
		let granted = true;
		kernel.provide(PERMISSIONS, {
			answer: () => (granted ? { granted: true } : { granted: false, reason: "withdrawn" }),
		} satisfies PermissionSource);
		kernel.mount({
			name: "greeter",
			requires: [MAY_GREET],
			activate: (c) => c.contribute(GREETING, "hello"),
		});
		expect(kernel.extensions.of(GREETING)).toEqual(["hello"]);

		// `replace`, not a second `provide`: two providers for one key would make the
		// winner depend on import order, and the kernel refuses that by name.
		granted = false;
		kernel.replace(PERMISSIONS, {
			answer: () => ({ granted: false, reason: "withdrawn" }),
		} satisfies PermissionSource);

		expect(kernel.extensions.of(GREETING)).toEqual([]);
	});

	it("takes only its own away when one of several components goes", () => {
		const kernel = new Kernel();
		kernel.mount({ name: "english", activate: (c) => c.contribute(GREETING, "hello") });
		const unmount = kernel.mount({
			name: "spanish",
			activate: (c) => c.contribute(GREETING, "hola"),
		});

		unmount();

		expect(kernel.extensions.of(GREETING)).toEqual(["hello"]);
	});

	it("takes one contribution away, not every contribution its owner made", () => {
		// Removing by owner name rather than by identity is a bug that shows up only when
		// one component contributes several values and drops one. The first version of
		// this test unwound the whole scope, which removes both either way, so a
		// by-owner removal passed it: the control did not fire and that was the finding.
		const kernel = new Kernel();
		let dropOne = (): void => {};

		kernel.mount({
			name: "polyglot",
			activate: (c) => {
				dropOne = c.contribute(GREETING, "hello");
				c.contribute(GREETING, "hola");
			},
		});
		expect(kernel.extensions.of(GREETING)).toHaveLength(2);

		dropOne();

		expect(kernel.extensions.of(GREETING)).toEqual(["hola"]);
	});

	it("still takes everything when the component itself goes", () => {
		const kernel = new Kernel();
		const unmount = kernel.mount({
			name: "polyglot",
			activate: (c) => {
				c.contribute(GREETING, "hello");
				c.contribute(GREETING, "hola");
			},
		});

		unmount();

		expect(kernel.extensions.of(GREETING)).toEqual([]);
	});

	it("does not contribute at all while it is waiting for something", () => {
		const kernel = new Kernel();

		kernel.mount({
			name: "greeter",
			needs: [CLOCK],
			activate: (c) => c.contribute(GREETING, "hello"),
		});

		expect(kernel.extensions.of(GREETING)).toEqual([]);

		kernel.provide(CLOCK, () => 0);

		expect(kernel.extensions.of(GREETING)).toEqual(["hello"]);
	});
});

describe("the built-in tools now go through it", () => {
	it("offers the six, in the order they are declared", () => {
		const kernel = new Kernel();

		const bench = mountBuiltins(kernel, everything);

		expect(bench.tools.map((tool) => tool.name)).toEqual([
			"read_file",
			"list_dir",
			"write_file",
			"edit_file",
			"run_command",
			"finish",
		]);
	});

	it("stops offering what a withdrawn permission covered", () => {
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, grantedPermissions([TOOL_PERMISSIONS.readFiles]));

		expect(bench.tools.map((tool) => tool.name)).toEqual(["read_file", "list_dir", "finish"]);
	});

	it("reads the catalogue from the point, not from a list the module keeps", () => {
		// The inversion, asserted where it can be seen: what `mountBuiltins` returns and
		// what the kernel holds are the same thing, so a contributor that is not a
		// built-in appears without this module knowing it exists.
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, everything);

		expect(bench.tools).toEqual(kernel.extensions.of(TOOL_POINT));
	});
});
