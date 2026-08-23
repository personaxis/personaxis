/**
 * This machine, declared rather than assumed.
 *
 * The point of these is not that the daemon runs work, which it always did. It is that
 * the daemon can now be asked what it is, so a refusal has a reason with two machine
 * names in it instead of a job that quietly did not move.
 */

import { describe, expect, it } from "vitest";

import { worlds } from "@personaxis/core";

import { confinementBackend, thisMachine, willRun } from "../src/workspace/world.js";

const policy = (over: Partial<worlds.ConfinementPolicy> = {}): worlds.ConfinementPolicy => ({
	mode: "workspace-write",
	writableRoots: ["/work/repo"],
	egressAllowlist: [],
	...over,
});

describe("what this machine can actually confine with", () => {
	it("names a complete backend where there is one", () => {
		expect(confinementBackend("linux")).toMatchObject({ completeness: "complete" });
		expect(confinementBackend("darwin")).toMatchObject({ completeness: "complete" });
	});

	it("reports Windows as partial, and names what it does not cover", () => {
		// It restricts writes and not reads or network. Saying that out loud is worth
		// more than the restriction it is admitting to.
		expect(confinementBackend("win32")).toEqual({
			name: "windows-acl",
			completeness: "partial",
			gaps: ["reads", "network"],
		});
	});

	it("has nothing at all for a platform nobody wrote one for", () => {
		// Not "probably fine". Fail-closed is the reading that does not quietly run
		// unconfined.
		expect(confinementBackend("aix")).toBeUndefined();
	});
});

describe("the daemon declares itself as a world", () => {
	it("says which machine, by a name somebody can walk to", () => {
		expect(thisMachine({ label: "davids-laptop" }).label).toBe("davids-laptop");
		expect(thisMachine().kind).toBe("machine");
	});

	it("has both seams from the same place, which is what not-a-split-world means", () => {
		expect(worlds.coherent(thisMachine({ os: "linux" }))).toBe(true);
	});
});

describe("whether this machine will run a step", () => {
	it("runs one it can confine", () => {
		const result = willRun(policy(), undefined, { os: "linux", label: "a" });

		expect(result.ok).toBe(true);
	});

	it("refuses a confined mode on a platform with no backend, and says why", () => {
		const result = willRun(policy(), undefined, { os: "aix", label: "a" });

		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("worse than not running");
	});

	it("runs an unconfined mode anywhere, because there is nothing to confine", () => {
		// A persona deliberately granted full access must not be refused with a message
		// about a confinement it never asked for.
		const result = willRun(policy({ mode: "full" }), undefined, { os: "aix", label: "a" });

		expect(result.ok).toBe(true);
	});

	it("refuses a step whose predecessor ran somewhere else, naming both machines", () => {
		const elsewhere: worlds.World = {
			kind: "machine",
			label: "anas-laptop",
			seams: { files: "local", processes: "local" },
		};

		const result = willRun(policy(), elsewhere, { os: "linux", label: "davids-laptop" });

		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("anas-laptop");
		expect(!result.ok && result.reason).toContain("davids-laptop");
	});

	it("carries on when the previous step ran here", () => {
		const same = thisMachine({ os: "linux", label: "davids-laptop" });

		expect(willRun(policy(), same, { os: "linux", label: "davids-laptop" }).ok).toBe(true);
	});

	it("stops refusing the day a transport exists, with nothing else changing", () => {
		const elsewhere: worlds.World = {
			kind: "machine",
			label: "anas-laptop",
			seams: { files: "local", processes: "local" },
		};

		const result = willRun(policy(), elsewhere, {
			os: "linux",
			label: "davids-laptop",
			transport: {},
		});

		expect(result.ok).toBe(true);
	});
});
